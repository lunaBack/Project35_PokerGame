/**
 * net_sim.js —— 联机模块无头集成测试（不依赖真实网络与 Tauri）
 * 在同一 vm 沙箱内运行：房主（NetHost + 权威引擎）+ 3 个脚本房员（收快照、回传动作）。
 * 覆盖：握手/版本校验、入座、完整对局（亮牌/三五反/进贡/扣底/出牌/结算）、
 *       非法动作拒绝重试、房员掉线 AI 托管、中途掉线接管。
 * 运行：node test/net_sim.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const base = path.join(__dirname, '..', 'web', 'js');
let code = '';
for (const f of ['cards.js', 'rules.js', 'ai.js', 'mc.js', 'game.js', 'net_proto.js', 'host.js', 'client.js']) {
    code += fs.readFileSync(path.join(base, f), 'utf8') + '\n';
}

// 超时保护：任何死锁都按失败处理
setTimeout(() => { console.error('FAIL: 测试超时（疑似死锁）'); process.exit(1); }, 180000);

/* ==================== 沙箱基础设施 ==================== */

function makeFakeEl() {
    return {
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        style: {}, dataset: {}, textContent: '', innerHTML: '', disabled: false,
        appendChild() {}, onclick: null, firstChild: { textContent: '' },
    };
}
const elCache = {};
const sandbox = {
    console, setTimeout, clearTimeout, setImmediate, clearImmediate, process, Date, Promise, JSON, Math, Set, Map, Infinity,
    navigator: { clipboard: { writeText: async () => {} } },
    window: {},
    $: id => (elCache[id] = elCache[id] || makeFakeEl()),
    document: { createElement: makeFakeEl, querySelector: () => makeFakeEl() },
};
sandbox.global = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);

/* ==================== mock UI（房主本地界面） ==================== */

const harness = `
'use strict';
delay = () => Promise.resolve();

var errors = [];
var handCount = 0;
var HANDS = 2;

var UI = {
    game: null,
    selectedIds: new Set(),
    selecting: false,
    log(msg) {},
    toast(m) {},
    render(g) { this.game = g; },
    renderMyHand() {},
    clearTable() {},
    markWinner() {},
    setTurnGlow() {},
    showModal() { return Promise.resolve(true); },
    showSettlement(game) {
        // 结算时校验引擎不变量（与 sim.js 相同口径）
        if (game.defenderPoints < 0 || game.defenderPoints > 100) errors.push('闲家得分越界: ' + game.defenderPoints);
        if (game.defenderPoints % 5 !== 0) errors.push('得分非5倍数: ' + game.defenderPoints);
        for (const p of game.players) if (p.hand.length !== 0) errors.push('局末手牌未打空: ' + p.name + ' ' + p.hand.length);
        if (game.bottom.length !== 6) errors.push('底牌数量异常: ' + game.bottom.length);
        const bottomPts = totalPoints(game.bottom);
        const played = totalPoints(game.playedCards);
        if (played + bottomPts !== 100) errors.push('总分不等于100: 打出' + played + ' + 底' + bottomPts);
        handCount++;
        return Promise.resolve(true);
    },
    askRevealTrump(twos) { return Promise.resolve(null); },
    askFanReveal() { return Promise.resolve([]); },
    askReturnTribute(hand, ctx) { return Promise.resolve(AI.chooseReturnTribute(hand, ctx)); },
    askBury(hand, ctx) { return Promise.resolve(AI.chooseBury(hand, ctx)); },
    askPlay(player, game, isLead) {
        if (isLead) return Promise.resolve(AI.heurLead(player.hand, game.ctx, game.otherHands(player.idx)));
        return Promise.resolve(game.fallbackFollow(player));
    },
};
`;

/* ==================== 脚本房员 ==================== */

const memberHarness = `
/** 脚本房员：收快照 → 按 ask 用启发式生成动作回传；被拒后降级为保守合法动作 */
function makeMember(name) {
    return {
        name,
        connId: -1,
        attempts: 0,      // 当前决策的重试次数（host 拒绝会重新下发同一 ask）
        lastAskKey: '',
        inbox: [],
        send(m) { mockTransport.memberSend(this.connId, m); },
        pseudoCtx(s) {
            return makeRuleCtx(s.trumpSuit,
                new Set(s.fan5.map(t => NET_CARD_ID[t])),
                new Set(s.fan3.map(t => NET_CARD_ID[t])));
        },
        hand(s) { return s.myHand.map(NetProto.parse); },
        onMessage(m) {
            this.inbox.push(m);
            if (m.t !== 'state' || !m.ask) { this.attempts = 0; this.lastAskKey = ''; return; }
            const s = m, ask = m.ask;
            const key = ask.kind + ':' + s.trickNo + ':' + s.turn + ':' + s.handNo;
            this.attempts = (key === this.lastAskKey) ? this.attempts + 1 : 0;
            this.lastAskKey = key;
            const ctx = this.pseudoCtx(s);
            const hand = this.hand(s);
            if (ask.kind === 'reveal') {
                const chosen = AI.chooseRevealTrump(hand, ask.firstHand);
                this.send({ t: 'action', kind: 'reveal', chosen: chosen ? NetProto.ser(chosen) : null });
            } else if (ask.kind === 'fan') {
                this.send({ t: 'action', kind: 'fan', picks: ask.options });  // 全亮
            } else if (ask.kind === 'tributeBack') {
                const back = AI.chooseReturnTribute(hand, ctx);
                this.send({ t: 'action', kind: 'tributeBack', chosen: NetProto.ser(back) });
            } else if (ask.kind === 'bury') {
                const sel = AI.chooseBury(hand, ctx);
                this.send({ t: 'action', kind: 'bury', cards: sel.map(NetProto.ser) });
            } else if (ask.kind === 'play') {
                let sel;
                if (this.attempts > 0) {
                    sel = ask.isLead ? [this.smallest(hand, ctx)] : this.safeFollow(hand, s.lead, ctx);
                } else if (ask.isLead) {
                    sel = AI.heurLead(hand, ctx, [[], [], []]);
                } else {
                    sel = AI.heurFollow(hand, s.trick.map(x => ({ cards: x.cards.map(NetProto.parse) })), s.lead, ctx, s.mySeat, (s.mySeat + 2) % 4);
                }
                this.send({ t: 'action', kind: 'play', cards: sel.map(NetProto.ser) });
            }
        },
        smallest(hand, ctx) {
            return hand.slice().sort((a, b) => strengthInGroup(a, ctx) - strengthInGroup(b, ctx))[0];
        },
        /** 与引擎 fallbackFollow 同逻辑的保守合法跟牌 */
        safeFollow(hand, lead, ctx) {
            const n = lead.count;
            const bySmall = (a, b) => strengthInGroup(a, ctx) - strengthInGroup(b, ctx);
            let first, rest;
            if (lead.type === 'trueGang') {
                first = hand.filter(c => isTrump(c, ctx)).sort(bySmall);
                rest = hand.filter(c => !isTrump(c, ctx)).sort(bySmall);
            } else if (lead.type === 'fakeGang') {
                first = hand.filter(c => !isTrump(c, ctx)).sort(bySmall);
                rest = hand.filter(c => isTrump(c, ctx)).sort(bySmall);
            } else {
                first = hand.filter(c => cardGroup(c, ctx) === lead.group).sort(bySmall);
                rest = hand.filter(c => cardGroup(c, ctx) !== lead.group).sort(bySmall);
            }
            return [...first, ...rest].slice(0, n);
        },
    };
}

/* ==================== mock 传输层（进程内管道，替代 Rust/Tauri） ==================== */

var nextConnId = 1;
var membersById = new Map();
var eventCb = null;
var rogueInbox = [];

var mockTransport = {
    listen: async () => 47535,
    localIp: async () => '127.0.0.1',
    stop: async () => {},
    disconnect: async (id) => {
        // 模拟房主主动断开某连接：双方各自收到 close
        membersById.delete(id);
        if (eventCb) eventCb({ kind: 'close', id, data: '' });
    },
    send: async (id, text) => {
        const m = JSON.parse(text);
        const mem = membersById.get(id);
        if (mem) { setImmediate(() => mem.onMessage(m)); }
        else rogueInbox.push(m);
    },
    onEvent: cb => { eventCb = cb; },
    memberSend(id, m) {
        setImmediate(() => { if (eventCb) eventCb({ kind: 'msg', id, data: JSON.stringify(m) }); });
    },
    memberConnect(member, hello) {
        const id = nextConnId++;
        member.connId = id;
        membersById.set(id, member);
        if (eventCb) eventCb({ kind: 'open', id, data: '' });
        eventCb({ kind: 'msg', id, data: JSON.stringify(hello) });
        return id;
    },
    memberClose(member) {
        const id = member.connId;
        membersById.delete(id);
        if (eventCb) eventCb({ kind: 'close', id, data: '' });
    },
};
`;

const testScript = `
(async () => {
    NetHost.transport = mockTransport;
    await NetHost.start();

    /* --- 版本不一致应被拒绝 --- */
    const rogue = makeMember('rogue');
    mockTransport.memberConnect(rogue, { t: 'hello', ver: NET_VER + 99, code: NetHost.code, name: '旧版' });
    await new Promise(r => setImmediate(r));
    if (!rogue.inbox.some(m => m.t === 'reject')) errors.push('版本握手未拒绝旧版客户端');

    /* --- 邀请码错误应被拒绝 --- */
    const rogue2 = makeMember('rogue2');
    mockTransport.memberConnect(rogue2, { t: 'hello', ver: NET_VER, code: 'XXXX', name: '串门' });
    await new Promise(r => setImmediate(r));
    if (!rogue2.inbox.some(m => m.t === 'reject')) errors.push('错误邀请码未被拒绝');

    /* --- 三个房员加入 --- */
    const mA = makeMember('测试A'), mB = makeMember('测试B'), mC = makeMember('测试C');
    mockTransport.memberConnect(mA, { t: 'hello', ver: NET_VER, code: NetHost.code, name: mA.name });
    mockTransport.memberConnect(mB, { t: 'hello', ver: NET_VER, code: NetHost.code, name: mB.name });
    mockTransport.memberConnect(mC, { t: 'hello', ver: NET_VER, code: NetHost.code, name: mC.name });
    await new Promise(r => setImmediate(r));
    const seats = [mA, mB, mC].map(m => NetHost.conns.get(m.connId).seat).sort();
    if (seats.join(',') !== '1,2,3') errors.push('座位分配异常: ' + seats.join(','));

    /* --- 完整对局（房主 + 3 脚本房员全交互） --- */
    // 确定性掉线注入：第二局起首次轮到 mC 决策时，先建立 pending 再断开连接，
    // 验证"等待中被断开 → 立即 AI 接管"路径
    const origWait = NetHost.waitAction.bind(NetHost);
    NetHost.waitAction = function (seat, kind, ask) {
        const conn = NetHost.conns.get(mC.connId);
        if (!mC.dropped && handCount >= 1 && conn && conn.seat === seat) {
            mC.dropped = true;
            const pr = origWait(seat, kind, ask);
            setImmediate(() => mockTransport.memberClose(mC));
            return pr;
        }
        return origWait(seat, kind, ask);
    };
    NetHost.startGame();

    const t0 = Date.now();
    while (handCount < HANDS) {
        await new Promise(r => setImmediate(r));
        if (Date.now() - t0 > 150000) { errors.push('对局推进卡死'); break; }
    }

    if (handCount < HANDS) errors.push('未完成 ' + HANDS + ' 局（实际 ' + handCount + '）');
    if (!mC.dropped) errors.push('掉线接管场景未被触发（pending 未等到 mC 的座位）');

    if (errors.length === 0) {
        console.log('net_sim PASS：' + handCount + ' 局全交互对局完成，版本握手/入座/拒绝重试/掉线托管均正常');
        process.exit(0);
    } else {
        console.error('net_sim FAIL:');
        errors.forEach(e => console.error(' - ' + e));
        process.exit(1);
    }
})().catch(e => { console.error('net_sim ERROR:', e && e.stack || e); process.exit(1); });
`;

vm.runInContext(code + harness + memberHarness + testScript, sandbox, { filename: 'net_sim-bundle.js' });
