/**
 * net_member_bot.js —— 真实 WebSocket 房员机器人（本机/局域网联测用）
 * 连接房主 Tauri 应用内嵌的 WS 服务端，自动完成：
 *   版本握手 → 入座 → 收快照 → 按启发式 AI 回传动作（非法被拒后自动降级为保守合法动作）
 * 决策逻辑与 web/js 前端同源（cards/rules/ai/net_proto），编码规则保证一致。
 *
 * 用法：node test/net_member_bot.js <邀请码或邀请串> [昵称]
 * 纯邀请码（如 K7Q2）→ 经公网中继（需环境变量 RELAY_URL，如 wss://xxx.workers.dev）
 * 邀请串（K7Q2@192.168.1.5:47535）→ 局域网直连
 * 可开多个终端同时跑多个机器人，座位由房主自动分配（1/2/3，满员观战）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let WebSocket;
try { WebSocket = require('ws'); }
catch (e) { console.error('缺少 ws 依赖：请先运行 npm install --save-dev ws'); process.exit(1); }

// 国内直连 workers.dev 被屏蔽：中继模式可设 RELAY_PROXY（如 http://127.0.0.1:7890）走代理
if (process.env.RELAY_PROXY) {
    import('https-proxy-agent').then(({ HttpsProxyAgent }) => {
        const agent = new HttpsProxyAgent(process.env.RELAY_PROXY);
        const Raw = WebSocket;
        WebSocket = class extends Raw {
            constructor(url, opts) { super(url, Object.assign({}, opts, { agent })); }
        };
        start();
    }).catch(e => { console.error('缺少 https-proxy-agent，无法走代理'); process.exit(1); });
} else {
    start();
}

function start() {

const argv = process.argv.slice(2);
const invite = argv[0] || '';
const NAME = (argv[1] || '机器人').replace(/[<>&"'\\]/g, '').slice(0, 8) || '机器人';
let CODE = '', HOST = '', RELAY = process.env.RELAY_URL || '';
const mm = invite.match(/^([A-Za-z0-9]+)@(.+)$/);
if (mm) { CODE = mm[1]; HOST = mm[2]; }                          // 局域网直连
else if (/^[A-Za-z0-9]{2,8}$/.test(invite)) { CODE = invite; }   // 纯邀请码 → 中继
else {
    console.error('用法: node test/net_member_bot.js <邀请码或邀请串> [昵称]');
    console.error('纯邀请码需环境变量 RELAY_URL（如 wss://xxx.workers.dev）');
    process.exit(1);
}
if (!HOST && !RELAY) { console.error('中继模式需要环境变量 RELAY_URL'); process.exit(1); }

/* 装载前端游戏脚本（与房主端同一份代码，保证牌编码/规则一致） */
const base = path.join(__dirname, '..', 'web', 'js');
let bundle = '';
for (const f of ['cards.js', 'rules.js', 'ai.js', 'mc.js', 'net_proto.js']) {
    bundle += fs.readFileSync(path.join(base, f), 'utf8') + '\n';
}
const sandbox = {
    console, WebSocket, setTimeout, clearTimeout, setImmediate,
    Promise, JSON, Math, Set, Map, Infinity, process, Date,
    navigator: { clipboard: { writeText: async () => {} } },
    HOST, CODE, NAME, RELAY,
};
sandbox.window = sandbox;
vm.createContext(sandbox);

const botScript = `
'use strict';
const log = (...a) => console.log('[' + NAME + ']', ...a);
const send = (o) => ws.send(JSON.stringify(o));

let attempts = 0, lastAskKey = '';

function pseudoCtx(s) {
    return makeRuleCtx(s.trumpSuit,
        new Set(s.fan5.map(t => NET_CARD_ID[t])),
        new Set(s.fan3.map(t => NET_CARD_ID[t])));
}
const handOf = (s) => s.myHand.map(NetProto.parse);

function smallest(hand, ctx) {
    return hand.slice().sort((a, b) => strengthInGroup(a, ctx) - strengthInGroup(b, ctx))[0];
}
/** 与引擎 fallbackFollow 同逻辑的保守合法跟牌（被拒后降级用） */
function safeFollow(hand, lead, ctx) {
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
}

function decide(s) {
    const ask = s.ask;
    const ctx = pseudoCtx(s);
    const hand = handOf(s);
    if (ask.kind === 'reveal') {
        const chosen = AI.chooseRevealTrump(hand, ask.firstHand);
        send({ t: 'action', kind: 'reveal', chosen: chosen ? NetProto.ser(chosen) : null });
        log('亮主询问 → ' + (chosen ? '亮 ' + chosen.suit + chosen.rank : '不亮'));
    } else if (ask.kind === 'fan') {
        send({ t: 'action', kind: 'fan', picks: ask.options });   // 全亮
        log('三五反询问 → 全部亮出');
    } else if (ask.kind === 'tributeBack') {
        const back = AI.chooseReturnTribute(hand, ctx);
        send({ t: 'action', kind: 'tributeBack', chosen: NetProto.ser(back) });
        log('还贡 → ' + back.suit + back.rank);
    } else if (ask.kind === 'bury') {
        const sel = AI.chooseBury(hand, ctx);
        send({ t: 'action', kind: 'bury', cards: sel.map(NetProto.ser) });
        log('扣底 6 张');
    } else if (ask.kind === 'play') {
        let sel;
        if (attempts > 0) {
            sel = ask.isLead ? [smallest(hand, ctx)] : safeFollow(hand, s.lead, ctx);
            log('上次被拒，降级保守出牌（第 ' + attempts + ' 次重试）');
        } else if (ask.isLead) {
            sel = AI.heurLead(hand, ctx, [[], [], []]);
        } else {
            sel = AI.heurFollow(hand, s.trick.map(x => ({ cards: x.cards.map(NetProto.parse) })), s.lead, ctx, s.mySeat, (s.mySeat + 2) % 4);
        }
        send({ t: 'action', kind: 'play', cards: sel.map(NetProto.ser) });
        log((ask.isLead ? '领出' : '跟牌') + ' ' + sel.length + ' 张');
    }
}

function onMsg(m) {
    if (m.p === 'err') { log('中继拒绝: ' + m.msg); process.exit(1); }  // 房间不存在等
    switch (m.t) {
        case 'welcome':
            log('握手成功，座位 ' + (m.seat >= 0 ? m.seat : '（观战）'));
            return;
        case 'reject':
            log('被房间拒绝: ' + m.msg);
            process.exit(1);
        case 'lobby':
            log('大厅座位: ' + m.names.join(' | '));
            return;
        case 'log':
            log('  [房主日志] ' + m.msg);
            return;
        case 'toast':
            log('  [提示] ' + m.msg);
            return;
    }
    if (m.t !== 'state') return;
    if (m.phase === 'settlement') {
        log('===== 第 ' + m.handNo + ' 局结算 =====');
        if (m.settlement && m.settlement.text) log(m.settlement.text.replace(/<[^>]+>/g, ' '));
        return;
    }
    if (!m.ask) { attempts = 0; lastAskKey = ''; return; }
    // 同一 ask 重复下发 = 上次动作被房主校验拒绝
    const key = m.ask.kind + ':' + m.trickNo + ':' + m.turn + ':' + m.handNo;
    attempts = (key === lastAskKey) ? attempts + 1 : 0;
    lastAskKey = key;
    decide(m);
}

const URL = HOST ? ('ws://' + HOST) : (RELAY + '/room/' + CODE + '?role=member');
log('连接 ' + URL + ' …（邀请码 ' + CODE + '）');
const ws = new WebSocket(URL);
ws.on('open', () => {
    log('已连接，发送握手');
    send({ t: 'hello', ver: NET_VER, code: CODE, name: NAME });
});
ws.on('message', (data) => {
    let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
    onMsg(m);
});
ws.on('close', () => { log('连接关闭（房主掉线或关房）→ 按约定本局作废'); process.exit(0); });
ws.on('error', (e) => { log('连接错误: ' + e.message); process.exit(1); });
`;

vm.runInContext(bundle + botScript, sandbox, { filename: 'net_member_bot.js' });
}
