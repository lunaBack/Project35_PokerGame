/**
 * eval.js —— 强度评测：hard（推演/模型）vs normal（启发式）对抗胜率
 * 运行：node test/eval.js [每组局数=24] [rollouts=24] [policy=mc|model] [模型路径=train/model.onnx]
 * 输出：hard 方对 normal 方的胜率与平均闲家得分
 */
'use strict';
const fs = require('fs');
const path = require('path');

const base = path.join(__dirname, '..', 'web', 'js');
let code = '';
for (const f of ['cards.js', 'rules.js', 'ai.js', 'mc.js', 'game.js']) {
    code += fs.readFileSync(path.join(base, f), 'utf8') + '\n';
}

const HANDS = parseInt(process.argv[2] || '24', 10);
const ROLLOUTS = parseInt(process.argv[3] || '24', 10);
const POLICY = process.argv[4] || 'mc';
const MODEL_PATH = process.argv[5] || path.join(__dirname, '..', 'train', 'model.onnx');

const script = `
delay = () => Promise.resolve();
MC.rollouts = ${ROLLOUTS};

// 全 AI 对局：resetHandState 会重建 players，故在此 hook 中关闭人类座位
const __origReset = Game.prototype.resetHandState;
Game.prototype.resetHandState = function () {
    __origReset.call(this);
    this.players[0].isHuman = false;
};

function makeMockUI(onSettle) {
    return {
        log() {}, render() {}, clearTable() {}, markWinner() {}, toast() {},
        askRevealTrump(twos, firstHand) { return Promise.resolve(AI.chooseRevealTrump(gameRef.players[0].hand, firstHand)); },
        askFanReveal(o) { return Promise.resolve(o); },
        askReturnTribute(h, c) { return Promise.resolve(AI.chooseReturnTribute(h, c)); },
        askBury(h, c) { return Promise.resolve(AI.chooseBury(h, c)); },
        showSettlement(game) { onSettle(game); return Promise.resolve(true); },
    };
}

async function runBlock(hardSeats, hands) {
    AI.seatDifficulty = { 0: 'normal', 1: 'normal', 2: 'normal', 3: 'normal' };
    for (const s of hardSeats) AI.seatDifficulty[s] = 'hard';
    const stats = { hardWins: 0, total: 0, defPts: 0 };
    gameRef = new Game(makeMockUI(g => {
        stats.total++;
        stats.defPts += g.defenderPoints;
        const hardTeam = TEAM_OF[hardSeats[0]];
        // 单局胜负：teamWins 中为 1 的队伍即本局胜方
        if (g.teamWins[hardTeam] === 1) stats.hardWins++;
        g.teamWins = [0, 0]; // 每局独立统计
        if (stats.total >= hands) throw new Error('BLOCK_DONE'); // 截断 playHand 自动续局递归
    }));
    gameRef.players[0].isHuman = false;
    try { await gameRef.playHand(); } catch (e) { if (e.message !== 'BLOCK_DONE') throw e; }
    return stats;
}

let gameRef;
var __start = async () => {
    const t0 = Date.now();
    const a = await runBlock([0, 2], ${HANDS});
    const b = await runBlock([1, 3], ${HANDS});
    const total = a.total + b.total;
    const wins = a.hardWins + b.hardWins;
    console.log('配置A（0/2 推演 vs 1/3 启发）：推演胜 ' + a.hardWins + '/' + a.total + '，平均闲家分 ' + (a.defPts / a.total).toFixed(1));
    console.log('配置B（1/3 推演 vs 0/2 启发）：推演胜 ' + b.hardWins + '/' + b.total + '，平均闲家分 ' + (b.defPts / b.total).toFixed(1));
    console.log('合计：推演胜率 ' + (100 * wins / total).toFixed(1) + '%（' + wins + '/' + total + '），耗时 ' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
};
`;

const vm = require('vm');
const sandbox = { console, setTimeout, process, require };
sandbox.global = sandbox;

(async () => {
    vm.createContext(sandbox);
    vm.runInContext(code + script + '\nvar __AIRef = AI; var __MCRef = MC;', sandbox, { filename: 'eval-bundle.js' });
    if (POLICY === 'model') {
        const scorer = require('./onnx_scorer');
        await scorer.init(MODEL_PATH, sandbox.__AIRef);
        sandbox.__MCRef.scorer = scorer.score;
        console.log('策略：model（' + MODEL_PATH + '）');
    } else {
        console.log('策略：mc（rollouts=' + ROLLOUTS + '）');
    }
    await sandbox.__start();
})();
