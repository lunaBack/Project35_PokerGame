/**
 * record.js —— 方案 A（蒙特卡洛推演）自博弈数据生成，供方案 B 训练使用
 * 运行：node test/record.js [局数=120] [输出=data/games_hard.jsonl] [策略=hard|model] [rollouts=16]
 * 每行一条决策样本（JSON）：
 *   { seat, team, dealer, dealerTeam, trump, fan5, fan3, hand, visible, trick, lead,
 *     isLead, chosen, cand: [[牌面]...] | null, candVals: [本队视角估值 0..1] | null,
 *     result: { defPts, winTeam } }
 * 牌面编码：'spadeQ' / 'BJ' / 'SJ'，进贡所得牌加 '*' 后缀
 */
'use strict';
const fs = require('fs');
const path = require('path');

const base = path.join(__dirname, '..', 'web', 'js');
let code = '';
for (const f of ['cards.js', 'rules.js', 'ai.js', 'mc.js', 'game.js']) {
    code += fs.readFileSync(path.join(base, f), 'utf8') + '\n';
}

const HANDS = parseInt(process.argv[2] || '120', 10);
const OUT = path.resolve(__dirname, '..', process.argv[3] || 'data/games_hard.jsonl');
const POLICY = process.argv[4] || 'hard';
const ROLLOUTS = parseInt(process.argv[5] || '16', 10);

const script = `
delay = () => Promise.resolve();
MC.rollouts = ${ROLLOUTS};
AI.setDifficulty(${JSON.stringify(POLICY === 'model' ? 'hard' : POLICY)});
if (typeof __modelScorer === 'function') MC.scorer = __modelScorer;

const __origReset = Game.prototype.resetHandState;
Game.prototype.resetHandState = function () { __origReset.call(this); this.players[0].isHuman = false; };

const ser = c => (c.suit === 'joker' ? c.rank : c.suit + c.rank) + (c.fromTribute ? '*' : '');
let buffer = [];   // 当前局决策样本
let done = 0;

function snapshot(game, idx, isLead, chosen) {
    const ctx = game.ctx;
    const cardById = new Map();
    for (const p of game.players) for (const c of p.hand) cardById.set(c.id, c);
    for (const c of game.playedCards) cardById.set(c.id, c);
    for (const c of game.bottom || []) cardById.set(c.id, c);
    const fanOf = (ids) => [...ids].map(id => cardById.has(id) ? ser(cardById.get(id)) : null).filter(Boolean);
    const visible = game.playedCards.map(ser);
    for (const t of game.trick) for (const c of t.cards) visible.push(ser(c));
    buffer.push({
        seat: idx, team: TEAM_OF[idx], dealer: game.dealer, dealerTeam: TEAM_OF[game.dealer],
        trump: ctx.trumpSuit, fan5: fanOf(ctx.fan5Ids), fan3: fanOf(ctx.fan3Ids),
        hand: game.players[idx].hand.map(ser),
        visible,
        trick: game.trick.map(t => ({ p: t.playerIdx, cards: t.cards.map(ser) })),
        lead: game.lead ? { type: game.lead.type, group: game.lead.group, count: game.lead.count } : null,
        isLead,
        chosen: chosen.map(ser),
        cand: __candCapture ? __candCapture.map(cs => cs.map(ser)) : null,
        candVals: __valCapture,
        result: null,
    });
}

// 只记录真实对局决策（推演内部调用不传 game，天然排除）
// 同时捕获 MC 候选列表（供策略头训练）
let __candCapture = null;
let __valCapture = null;
const __origEval = MC.evalCandidates.bind(MC);
MC.evalCandidates = async function (game, myIdx, cands, curTrick, curLead) {
    if (game) { __candCapture = cands; MC.lastValues = null; } // 防单候选早退时残留旧估值
    return __origEval(game, myIdx, cands, curTrick, curLead);
};
const __origLeadMC = MC.chooseLeadMC.bind(MC), __origFollowMC = MC.chooseFollowMC.bind(MC);
MC.chooseLeadMC = async function (game, myIdx) {
    if (game) {
        const hand = game.players[myIdx].hand;
        const heur = AI.heurLead(hand, game.ctx, game.otherHands(myIdx));
        __candCapture = MC.dedup(MC.leadCandidates(hand, game.ctx).concat([heur]));
    }
    return __origLeadMC(game, myIdx);
};
MC.chooseFollowMC = async function (game, myIdx) {
    if (game) {
        const hand = game.players[myIdx].hand;
        const partner = (myIdx + 2) % 4;
        const heur = AI.heurFollow(hand, game.trick, game.lead, game.ctx, myIdx, partner);
        __candCapture = MC.dedup(MC.followCandidates(hand, game.trick, game.lead, game.ctx, myIdx, partner).concat([heur]));
    }
    return __origFollowMC(game, myIdx);
};
const __lead = AI.chooseLead.bind(AI), __follow = AI.chooseFollow.bind(AI);
AI.chooseLead = async function (hand, ctx, others, game, idx) {
    if (game) { __candCapture = null; __valCapture = null; } // 只在真实决策重置；rollout 内部调用不传 game，不得清除捕获
    const chosen = await __lead(hand, ctx, others, game, idx);
    if (game) {
        if (MC.lastValues) __valCapture = MC.lastValues.map(v => MC.lastSign > 0 ? v / 100 : 1 + v / 100);
        snapshot(game, idx, true, chosen);
    }
    return chosen;
};
AI.chooseFollow = async function (hand, trick, lead, ctx, myIdx, partnerIdx, game) {
    if (game) { __candCapture = null; __valCapture = null; }
    const chosen = await __follow(hand, trick, lead, ctx, myIdx, partnerIdx, game);
    if (game) {
        if (MC.lastValues) __valCapture = MC.lastValues.map(v => MC.lastSign > 0 ? v / 100 : 1 + v / 100);
        snapshot(game, myIdx, false, chosen);
    }
    return chosen;
};

const g = new Game({
    log() {}, render() {}, clearTable() {}, markWinner() {}, toast() {},
    askRevealTrump(t, f) { return Promise.resolve(AI.chooseRevealTrump(g.players[0].hand, f)); },
    askFanReveal(o) { return Promise.resolve(o); },
    askReturnTribute(h, c) { return Promise.resolve(AI.chooseReturnTribute(h, c)); },
    askBury(h, c) { return Promise.resolve(AI.chooseBury(h, c)); },
    showSettlement(game) {
        done++;
        const winTeam = game.teamWins[0] === 1 ? 0 : 1;
        const lines = buffer.map(s => {
            s.result = { defPts: game.defenderPoints, winTeam };
            return JSON.stringify(s);
        });
        __append(lines.join('\\n') + (lines.length ? '\\n' : ''));
        buffer = [];
        if (done % 20 === 0) console.log('已记录 ' + done + ' 局');
        if (done >= ${HANDS}) throw new Error('RECORD_DONE');
        return Promise.resolve(true);
    },
});
(async () => {
    try { await g.playHand(); } catch (e) { if (e.message !== 'RECORD_DONE') throw e; }
    console.log('完成：' + done + ' 局，样本写入 ' + ${JSON.stringify(OUT)});
})();
`;

const vm = require('vm');
const sandbox = {
    console, setTimeout, process, require,
    __append: (txt) => { if (txt) fs.appendFileSync(OUT, txt, 'utf8'); },
};
sandbox.global = sandbox;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
if (fs.existsSync(OUT)) fs.rmSync(OUT); // 每次重新生成

(async () => {
    if (POLICY === 'model') {
        const scorer = require('./onnx_scorer');
        await scorer.init(path.join(__dirname, '..', 'train', 'model.onnx'));
        sandbox.__modelScorer = scorer.score;
        console.log('策略：model');
    }
    vm.createContext(sandbox);
    vm.runInContext(code + script, sandbox, { filename: 'record-bundle.js' });
})();
