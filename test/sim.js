/**
 * sim.js —— 无头模拟测试：四个 AI 自动对局 N 局，校验引擎与规则不变量
 * 运行：node test/sim.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const base = path.join(__dirname, '..', 'web', 'js');
let code = '';
for (const f of ['cards.js', 'rules.js', 'ai.js', 'game.js']) {
    code += fs.readFileSync(path.join(base, f), 'utf8') + '\n';
}

const HANDS = 120;
const test = `
delay = () => Promise.resolve(); // 测试中取消动画延时

let handCount = 0;
let errors = [];

const mockUI = {
    log(msg) { /* console.log(msg) */ },
    render() {}, clearTable() {}, markWinner() {}, toast(m) { errors.push('TOAST(人类校验失败提示不应出现于AI): ' + m); },
    askRevealTrump(twos, firstHand) {
        return Promise.resolve(AI.chooseRevealTrump(gameRef.players[0].hand, firstHand));
    },
    askFanReveal(options) { return Promise.resolve(options); },
    askReturnTribute(hand, ctx) { return Promise.resolve(AI.chooseReturnTribute(hand, ctx)); },
    askBury(hand, ctx) { return Promise.resolve(AI.chooseBury(hand, ctx)); },
    askPlay(player, game, isLead) {
        if (isLead) return Promise.resolve(AI.chooseLead(player.hand, game.ctx, game.otherHands(player.idx)));
        return Promise.resolve(AI.chooseFollow(player.hand, game.trick, game.lead, game.ctx, player.idx, (player.idx + 2) % 4));
    },
    showSettlement(game) {
        handCount++;
        // 不变量校验
        if (game.defenderPoints < 0 || game.defenderPoints > 100) {
            errors.push('闲家得分越界: ' + game.defenderPoints);
        }
        if (game.defenderPoints % 5 !== 0) errors.push('得分非5倍数: ' + game.defenderPoints);
        for (const p of game.players) {
            if (p.hand.length !== 0) errors.push('局末手牌未打空: ' + p.name + ' ' + p.hand.length);
        }
        if (game.bottom.length !== 6) errors.push('底牌数量异常: ' + game.bottom.length);
        const bottomPts = totalPoints(game.bottom);
        if (bottomPts > 0) errors.push('警告-底牌含分(应仅极端兜底出现): ' + bottomPts);
        const played = totalPoints(game.playedCards);
        if (played + bottomPts !== 100) errors.push('总分不等于100: 打出' + played + ' + 底' + bottomPts);
        if (handCount >= ${HANDS}) throw new Error('TEST_DONE');
        return Promise.resolve(true);
    },
};

// 包一层校验：验证每次跟牌都合法（引擎内部对 AI 也调用了 validateFollow，这里再次独立断言）
const origDoFollow = Game.prototype.doFollow;
Game.prototype.doFollow = async function (p) {
    const before = p.hand.slice();
    await origDoFollow.call(this, p);
    const played = this.trick[this.trick.length - 1].cards;
    const res = validateFollow(played, before, this.lead, this.ctx);
    if (!res.ok) errors.push('非法跟牌: ' + p.name + ' ' + played.map(cardText).join(',') + ' → ' + res.msg);
    // 独立断言：首家出主牌时，有主必出主、不足才可用副牌充数
    if (this.lead && this.lead.group === 'trump' && (this.lead.type === 'single' || this.lead.type === 'throw')) {
        const need = Math.min(this.lead.count, before.filter(c => isTrump(c, this.ctx)).length);
        const got = played.filter(c => isTrump(c, this.ctx)).length;
        if (got < need) errors.push('跟主牌约束被违反: ' + p.name + ' 应出主牌' + need + '张实出' + got + '张');
    }
};

let gameRef;
(async () => {
    try {
        gameRef = new Game(mockUI);
        await gameRef.playHand();
    } catch (e) {
        if (e.message !== 'TEST_DONE') { console.error('运行时异常:', e); process.exit(1); }
    }
    const uniq = [...new Set(errors)];
    console.log('完成 ' + handCount + ' 局模拟');
    if (uniq.length) {
        console.log('发现问题 ' + errors.length + ' 条（去重 ' + uniq.length + '）:');
        uniq.slice(0, 20).forEach(e => console.log('  - ' + e));
        process.exit(1);
    } else {
        console.log('所有不变量校验通过 ✓');
    }
})();
`;

// 独立执行拼接后的脚本
const vm = require('vm');
const sandbox = { console, setTimeout, process, require };
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(code + test, sandbox, { filename: 'sim-bundle.js' });
