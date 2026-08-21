/** dbg.js —— 定位 MC 卡点：1 局全 hard + 进度日志 */
'use strict';
const fs = require('fs');
const path = require('path');
const base = path.join(__dirname, '..', 'web', 'js');
let code = '';
for (const f of ['cards.js', 'rules.js', 'ai.js', 'mc.js', 'game.js']) {
    code += fs.readFileSync(path.join(base, f), 'utf8') + '\n';
}
const script = `
delay = () => Promise.resolve();
MC.rollouts = 2;

const __origReset = Game.prototype.resetHandState;
Game.prototype.resetHandState = function () { __origReset.call(this); this.players[0].isHuman = false; };

let decisions = 0, rollouts = 0;
const __ec = MC.evalCandidates.bind(MC);
MC.evalCandidates = async function (...a) {
    decisions++;
    console.log('[decision]', decisions, 'cands=' + a[2].length, 'lead=' + (a[4] ? 'follow' : 'lead'));
    const r = await __ec(...a);
    console.log('[decision done]', decisions);
    return r;
};
const __or = MC.oneRollout.bind(MC);
MC.oneRollout = async function (...a) { rollouts++; return __or(...a); };

const __pt = Game.prototype.playTrick;
Game.prototype.playTrick = async function (leader) {
    const w = await __pt.call(this, leader);
    console.log('[trick]', this.trickNo, 'hands=' + this.players.map(p => p.hand.length).join('/'), 'lead=' + (this.lead ? this.lead.type : '-'));
    return w;
};

const g = new Game({
    log() {}, render() {}, clearTable() {}, markWinner() {}, toast() {},
    askRevealTrump(t, f) { return Promise.resolve(AI.chooseRevealTrump(g.players[0].hand, f)); },
    askFanReveal(o) { return Promise.resolve(o); },
    askReturnTribute(h, c) { return Promise.resolve(AI.chooseReturnTribute(h, c)); },
    askBury(h, c) { return Promise.resolve(AI.chooseBury(h, c)); },
    showSettlement(game) { console.log('[settle] defPts=' + game.defenderPoints + ' rollouts=' + rollouts); return Promise.resolve(true); },
});
AI.setDifficulty('hard');
(async () => { await g.playHand(); console.log('[hand1 done]'); await g.playHand(); console.log('[done]'); process.exit(0); })();
`;
const vm = require('vm');
const sandbox = { console, setTimeout, process, require };
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(code + script, sandbox, { filename: 'dbg-bundle.js' });
