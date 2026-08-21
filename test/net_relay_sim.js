/**
 * net_relay_sim.js —— 中继模式无头集成测试（依赖本地 wrangler dev 中继）
 * 先启动本地中继：npx wrangler dev --config server\wrangler.toml --port 8787
 * 房主：NetHost.relayTransport 单条 WebSocket 连入 /room/CODE?role=host
 * 房员：真实 WebSocket（ws 包）连入 /room/CODE?role=member
 * 覆盖：Worker 信封多路复用、握手拒绝、入座、完整对局、房员掉线 AI 托管。
 * 运行：node test/net_relay_sim.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
let NodeWebSocket = require('ws');

const RELAY = process.env.RELAY_URL || 'ws://127.0.0.1:8787';
const FIXED_CODE = 'TEST';

// 国内直连 workers.dev 被屏蔽：设置 RELAY_PROXY（如 http://127.0.0.1:7890）后所有连接走代理
async function main() {
if (process.env.RELAY_PROXY && RELAY.startsWith('wss://')) {
    const { HttpsProxyAgent } = await import('https-proxy-agent');
    const agent = new HttpsProxyAgent(process.env.RELAY_PROXY);
    const Raw = NodeWebSocket;
    NodeWebSocket = class extends Raw {
        constructor(url, opts) { super(url, Object.assign({}, opts, { agent })); }
    };
}

const base = path.join(__dirname, '..', 'web', 'js');
let code = '';
for (const f of ['cards.js', 'rules.js', 'ai.js', 'mc.js', 'game.js', 'net_proto.js', 'host.js']) {
    code += fs.readFileSync(path.join(base, f), 'utf8') + '\n';
}

setTimeout(() => { console.error('FAIL: 测试超时（疑似死锁）'); process.exit(1); }, 240000);

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
    WebSocket: NodeWebSocket,
    navigator: { clipboard: { writeText: async () => {} } },
    window: {},
    $: id => (elCache[id] = elCache[id] || makeFakeEl()),
    document: { createElement: makeFakeEl, querySelector: () => makeFakeEl() },
};
sandbox.global = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);

/* ==================== mock UI（房主本地界面，与 net_sim 同口径） ==================== */

const harness = `
'use strict';
var errors = [];
var handCount = 0;
var HANDS = 2;

var UI = {
    game: null, selectedIds: new Set(), selecting: false,
    log(msg) {}, toast(m) {},
    render(g) { this.game = g; },
    renderMyHand() {}, clearTable() {}, markWinner() {}, setTurnGlow() {},
    showModal() { return Promise.resolve(true); },
    showSettlement(game) {
        if (game.defenderPoints < 0 || game.defenderPoints > 100) errors.push('闲家得分越界: ' + game.defenderPoints);
        if (game.defenderPoints % 5 !== 0) errors.push('得分非5倍数: ' + game.defenderPoints);
        for (const p of game.players) if (p.hand.length !== 0) errors.push('局末手牌未打空: ' + p.name + ' ' + p.hand.length);
        if (game.bottom.length !== 6) errors.push('底牌数量异常: ' + game.bottom.length);
        if (totalPoints(game.playedCards) + totalPoints(game.bottom) !== 100) errors.push('总分不等于100');
        handCount++;
        return Promise.resolve(true);
    },
    askRevealTrump() { return Promise.resolve(null); },
    askFanReveal() { return Promise.resolve([]); },
    askReturnTribute(hand, ctx) { return Promise.resolve(AI.chooseReturnTribute(hand, ctx)); },
    askBury(hand, ctx) { return Promise.resolve(AI.chooseBury(hand, ctx)); },
    askPlay(player, game, isLead) {
        if (isLead) return Promise.resolve(AI.heurLead(player.hand, game.ctx, game.otherHands(player.idx)));
        return Promise.resolve(game.fallbackFollow(player));
    },
};
`;

/* ==================== 真实 WebSocket 房员 ==================== */

const memberHarness = `
/** 房员：经中继的真实 WebSocket；收快照 → 按 ask 用启发式生成动作回传 */
function makeMember(name) {
    return {
        name, ws: null, connId: -1, attempts: 0, lastAskKey: '', inbox: [], welcomeOk: false, relayErr: '',
        connect(code) {
            return new Promise((resolve) => {
                this.ws = new WebSocket(RELAY_URL + '/room/' + code + '?role=member');
                this.ws.onopen = () => {
                    this.ws.send(JSON.stringify({ t: 'hello', ver: NET_VER, code, name: this.name }));
                    resolve();
                };
                this.ws.onmessage = (e) => {
                    let m; try { m = JSON.parse(e.data); } catch (err) { return; }
                    if (m && m.p === 'err') { this.relayErr = m.msg; return; }
                    this.onMessage(m);
                };
                this.ws.onerror = () => {};
            });
        },
        close() { try { this.ws.close(); } catch (e) {} },
        send(m) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); },
        pseudoCtx(s) {
            return makeRuleCtx(s.trumpSuit,
                new Set(s.fan5.map(t => NET_CARD_ID[t])),
                new Set(s.fan3.map(t => NET_CARD_ID[t])));
        },
        hand(s) { return s.myHand.map(NetProto.parse); },
        onMessage(m) {
            this.inbox.push(m);
            if (m.t === 'welcome') { this.welcomeOk = true; return; }
            if (m.t === 'reject') { this.close(); return; }  // 与真实客户端一致：被拒后断开
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
                this.send({ t: 'action', kind: 'fan', picks: ask.options });
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
`;

const testScript = `
(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    /* --- 房主经中继建房（固定码 TEST，覆盖 makeCode） --- */
    NetProto.makeCode = () => FIXED_CODE;
    NetHost.transport = NetHost.relayTransport(RELAY_URL, FIXED_CODE);
    await NetHost.start();
    if (NetHost.inviteString() !== FIXED_CODE) errors.push('邀请串未变为纯邀请码: ' + NetHost.inviteString());

    /* --- 不存在的房间：Worker 应回 no such room --- */
    const ghost = makeMember('幽灵');
    await ghost.connect('ZZZZ');
    await sleep(400);
    if (ghost.relayErr !== 'no such room') errors.push('不存在的房间未被中继拒绝: ' + ghost.relayErr);

    /* --- 版本不一致：经中继到达房主后应被 reject --- */
    const rogue = makeMember('旧版');
    await rogue.connect(FIXED_CODE);
    rogue.ws.send(JSON.stringify({ t: 'hello', ver: NET_VER + 99, code: FIXED_CODE, name: '旧版' }));
    await sleep(400);
    if (!rogue.inbox.some(m => m.t === 'reject')) errors.push('版本握手未拒绝旧版客户端');

    /* --- 三个房员加入 --- */
    const mA = makeMember('测试A'), mB = makeMember('测试B'), mC = makeMember('测试C');
    await mA.connect(FIXED_CODE);
    await mB.connect(FIXED_CODE);
    await mC.connect(FIXED_CODE);
    await sleep(500);
    for (const m of [mA, mB, mC]) if (!m.welcomeOk) errors.push(m.name + ' 未收到 welcome');
    if (NetHost.conns.size !== 3) errors.push('房主侧连接数异常: ' + NetHost.conns.size);
    const seats = [...NetHost.conns.values()].map(c => c.seat).sort();
    if (seats.join(',') !== '1,2,3') errors.push('座位分配异常: ' + seats.join(','));

    /* --- 完整对局（含 mC 中途掉线 → AI 托管） --- */
    const origWait = NetHost.waitAction.bind(NetHost);
    NetHost.waitAction = function (seat, kind, ask) {
        const conn = [...NetHost.conns.entries()].find(([, c]) => c === connByName('测试C'));
        function connByName(n) { for (const c of NetHost.conns.values()) if (c.name === n) return c; return null; }
        if (!mC.dropped && handCount >= 1 && conn && conn[1].seat === seat) {
            mC.dropped = true;
            const pr = origWait(seat, kind, ask);
            setTimeout(() => mC.close(), 20);
            return pr;
        }
        return origWait(seat, kind, ask);
    };
    NetHost.startGame();

    const t0 = Date.now();
    while (handCount < HANDS) {
        await sleep(10);
        if (Date.now() - t0 > 200000) { errors.push('对局推进卡死'); break; }
    }
    if (handCount < HANDS) errors.push('未完成 ' + HANDS + ' 局（实际 ' + handCount + '）');
    if (!mC.dropped) errors.push('掉线接管场景未被触发');

    /* --- 房主关房：房员应被 Worker 断开 --- */
    let aClosed = false;
    mA.ws.onclose = () => { aClosed = true; };
    NetHost.transport.stop();
    await sleep(500);
    if (!aClosed) errors.push('房主关房后房员连接未被中继关闭');

    if (errors.length === 0) {
        console.log('net_relay_sim PASS：' + handCount + ' 局经中继对局完成，握手/入座/掉线托管/关房广播均正常');
        process.exit(0);
    } else {
        console.error('net_relay_sim FAIL:');
        errors.forEach(e => console.error(' - ' + e));
        process.exit(1);
    }
})().catch(e => { console.error('net_relay_sim ERROR:', e && e.stack || e); process.exit(1); });
`;

sandbox.RELAY_URL = RELAY;
sandbox.FIXED_CODE = FIXED_CODE;
vm.runInContext(code + harness + memberHarness + testScript, sandbox, { filename: 'net_relay_sim-bundle.js' });
}
main();
