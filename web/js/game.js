/**
 * game.js —— 三五反游戏流程状态机
 * 流程：发牌 → 定主亮牌(抢亮/断电) → 亮三五反 → 进贡还贡 → 庄家扣底 → 出牌 → 结算
 */
'use strict';

const TEAM_OF = [0, 1, 0, 1];               // 座位 → 队伍：0/2 一队，1/3 一队
const PLAYER_NAMES = ['你', '右家', '对家', '左家'];

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

/** 出牌节奏倍率（由设置面板控制；无头环境恒为 1） */
function speedMult() {
    return (typeof AppSettings !== 'undefined' && AppSettings) ? AppSettings.speedMult() : 1;
}

class Game {
    constructor(ui) {
        this.ui = ui;
        this.handNo = 0;
        this.dealer = -1;            // 庄家座位
        this.tributePlan = [];       // 上局结算产生的进贡计划 [{from,to}]
        this.teamWins = [0, 0];      // 双方胜局数（闲家上台记闲家胜，庄家保台记庄家胜）
        this.loadRecord();
        this.resetHandState();
    }

    /** 从 localStorage 恢复战绩 */
    loadRecord() {
        try {
            const raw = localStorage.getItem('swf_record');
            if (raw) {
                const r = JSON.parse(raw);
                if (Array.isArray(r.teamWins) && r.teamWins.length === 2) this.teamWins = r.teamWins;
            }
        } catch (e) { /* 非浏览器环境忽略 */ }
    }

    /** 战绩写入 localStorage */
    saveRecord() {
        try { localStorage.setItem('swf_record', JSON.stringify({ teamWins: this.teamWins })); } catch (e) {}
    }

    resetRecord() {
        this.teamWins = [0, 0];
        this.saveRecord();
        this.ui.render(this);
    }

    resetHandState() {
        this.players = [0, 1, 2, 3].map(i => ({
            idx: i, name: PLAYER_NAMES[i], isHuman: i === 0, team: TEAM_OF[i], hand: [],
        }));
        this.bottom = [];
        this.trumpSuit = null;
        this.trumpRevealer = -1;
        this.blackout = false;
        this.fan5Ids = new Set();
        this.fan3Ids = new Set();
        this.fanTeams = new Set();   // 本局亮过三五反的队伍
        this.ctx = null;
        this.defenderPoints = 0;     // 闲家方得分
        this.scoreLog = [];          // 闲家得分明细 [{no, who, pts}]
        this.trickNo = 0;            // 当前轮次
        this.curLeader = -1;         // 当前轮领出者
        this.nextDealer = -1;        // 下局庄家（结算后供弹窗展示）
        this.trick = [];             // 当前轮已出牌
        this.lead = null;
        this.playedCards = [];
    }

    log(msg, cls) { this.ui.log(msg, cls); }

    defenderTeam() { return 1 - TEAM_OF[this.dealer]; }

    /* ==================== 主流程 ==================== */

    async playHand() {
        this.handNo++;
        this.resetHandState();
        this.log(`—— 第 ${this.handNo} 局开始 ——`, 'title');
        this.ui.render(this);

        await this.dealPhase();
        await this.revealTrumpPhase();
        await this.fanRevealPhase();
        await this.tributePhase();
        await this.buryPhase();
        await this.playPhase();
        await this.settlePhase();
    }

    /* ==================== 发牌 ==================== */

    async dealPhase() {
        const deck = shuffle(createDeck());
        // 逐张轮发（记录每人拿到 2 的先后次序，用于"抢亮"优先级）
        const start = this.dealer >= 0 ? (this.dealer + 1) % 4 : 0;
        this.dealOrderOfTwo = [Infinity, Infinity, Infinity, Infinity];
        for (let k = 0; k < 48; k++) {
            const p = (start + k) % 4;
            const card = deck[k];
            this.players[p].hand.push(card);
            if (card.rank === '2' && this.dealOrderOfTwo[p] === Infinity) {
                this.dealOrderOfTwo[p] = k;
            }
        }
        this.bottom = deck.slice(48);
        this.ui.render(this);
        this.log('发牌完成：每人 12 张，底牌 6 张。');
        await delay(300 * speedMult());
    }

    /* ==================== 定主亮牌 ==================== */

    async revealTrumpPhase() {
        const firstHand = this.dealer < 0;
        // 按拿到 2 的先后次序依次询问（模拟发牌过程中的"抢亮"）
        const order = [0, 1, 2, 3]
            .filter(i => this.dealOrderOfTwo[i] !== Infinity)
            .sort((a, b) => this.dealOrderOfTwo[a] - this.dealOrderOfTwo[b]);

        for (const i of order) {
            const p = this.players[i];
            const twos = p.hand.filter(c => c.rank === '2' && c.suit !== 'joker');
            let chosen = null;
            if (p.isHuman || p.remote) {
                chosen = await this.ui.askRevealTrump(twos, firstHand, p);
            } else {
                chosen = AI.chooseRevealTrump(p.hand, firstHand);
                await delay(400 * speedMult());
            }
            if (chosen) {
                this.trumpSuit = chosen.suit;
                this.trumpRevealer = i;
                if (firstHand) {
                    this.dealer = i; // 首局：抢亮者为庄家
                    this.log(`${p.name} 抢亮 ${cardText(chosen)}，成为庄家，主牌花色为 ${SUIT_NAME[chosen.suit]}！`, 'important');
                } else {
                    this.log(`${p.name} 亮出 ${cardText(chosen)}，主牌花色为 ${SUIT_NAME[chosen.suit]}。`, 'important');
                }
                break;
            }
        }

        // 断电规则：无人亮牌
        if (!this.trumpSuit) {
            this.blackout = true;
            if (firstHand) {
                // 首局断电：由最先拿到 2 的玩家当庄；若四人的 2 全在底牌则兑底随机定庄
                const withTwo = [0, 1, 2, 3]
                    .filter(i => this.dealOrderOfTwo[i] !== Infinity)
                    .sort((a, b) => this.dealOrderOfTwo[a] - this.dealOrderOfTwo[b]);
                if (withTwo.length > 0) {
                    this.dealer = withTwo[0];
                    this.log(`无人亮牌（断电）。首局断电：由最先拿到 2 的 ${this.players[this.dealer].name} 当庄。`, 'important');
                } else {
                    this.dealer = Math.floor(Math.random() * 4);
                    this.log(`无人亮牌（断电），且四人的 2 均在底牌：随机确定 ${this.players[this.dealer].name} 为庄家。`);
                }
            } else {
                this.log('无人亮牌（断电）。', 'important');
            }
            // 不做庄的一方从底牌中随机抽一张定主花色，大小王重抽
            let pool = this.bottom.filter(c => c.suit !== 'joker');
            const pick = pool[Math.floor(Math.random() * pool.length)];
            this.trumpSuit = pick.suit;
            const drawer = this.players[(this.dealer + 1) % 4];
            this.log(`断电：由闲家 ${drawer.name} 从底牌抽出 ${cardText(pick)}（大小王重抽），主牌花色为 ${SUIT_NAME[pick.suit]}；本局闲家免进贡处罚。`, 'important');
        }

        this.ctx = makeRuleCtx(this.trumpSuit, this.fan5Ids, this.fan3Ids);
        this.ui.render(this);
        await delay(400 * speedMult());
    }

    /* ==================== 亮三五反 ==================== */

    async fanRevealPhase() {
        // 主家扣底之前，起到三个3或三个5可以亮（进贡所得牌不能用于构成三五反）
        for (let k = 0; k < 4; k++) {
            const i = (this.dealer + k) % 4;
            const p = this.players[i];
            const options = AI.chooseFanReveal(p.hand);
            if (options.length === 0) continue;
            let picks;
            if (p.isHuman || p.remote) {
                picks = await this.ui.askFanReveal(options, p);
            } else {
                picks = options; // AI 总是亮（成为大主 + 免进贡）
                await delay(400 * speedMult());
            }
            for (const opt of picks) {
                const ids = opt.rank === '5' ? this.fan5Ids : this.fan3Ids;
                for (const c of opt.cards) ids.add(c.id);
                this.fanTeams.add(p.team);
                const name = opt.rank === '5' ? '五反' : '三反';
                this.log(`${p.name} 亮出${name}：${opt.cards.map(cardText).join(' ')}（成为仅次于方片5的主牌）！`, 'important');
            }
        }
        this.ctx = makeRuleCtx(this.trumpSuit, this.fan5Ids, this.fan3Ids);
        this.ui.render(this);
    }

    /* ==================== 进贡与还贡 ==================== */

    async tributePhase() {
        if (this.tributePlan.length === 0) return;
        for (const { from, to } of this.tributePlan) {
            const payer = this.players[from], recv = this.players[to];
            // 亮三五反的一方免受进贡处罚
            if (this.fanTeams.has(payer.team)) {
                this.log(`${payer.name} 一方亮了三五反，免进贡。`, 'important');
                continue;
            }
            // 断电：不做庄的一方免向庄家进贡
            if (this.blackout && payer.team !== TEAM_OF[this.dealer] && recv.team === TEAM_OF[this.dealer]) {
                this.log(`断电：${payer.name}（闲家方）免向庄家方进贡。`, 'important');
                continue;
            }
            // 进贡：手上最大的主牌（无主或主牌全为分牌则免）
            const tri = AI.chooseTribute(payer.hand, this.ctx);
            if (!tri) {
                this.log(`${payer.name} 无主牌或主牌全为分牌，免进贡。`);
                continue;
            }
            payer.hand.splice(payer.hand.indexOf(tri), 1);
            const triGiven = { ...tri, fromTribute: true };
            recv.hand.push(triGiven);
            this.log(`${payer.name} 向 ${recv.name} 进贡 ${cardText(tri)}。`, 'important');
            // 还贡
            let back;
            if (recv.isHuman || recv.remote) {
                back = await this.ui.askReturnTribute(recv.hand, this.ctx, payer.name, recv);
            } else {
                back = AI.chooseReturnTribute(recv.hand, this.ctx);
                await delay(300 * speedMult());
            }
            recv.hand.splice(recv.hand.indexOf(back), 1);
            payer.hand.push({ ...back, fromTribute: true });
            this.log(`${recv.name} 还贡 ${cardText(back)} 给 ${payer.name}。`);
            this.ui.render(this);
        }
        this.tributePlan = [];
    }

    /* ==================== 庄家扣底 ==================== */

    async buryPhase() {
        const d = this.players[this.dealer];
        d.hand.push(...this.bottom);
        this.bottom = [];
        this.ui.render(this);
        this.log(`庄家 ${d.name} 收取 6 张底牌。`);

        let buried;
        if (d.isHuman || d.remote) {
            buried = await this.ui.askBury(d.hand, this.ctx, d);
        } else {
            buried = AI.chooseBury(d.hand, this.ctx);
            await delay(600 * speedMult());
        }
        for (const c of buried) d.hand.splice(d.hand.indexOf(c), 1);
        this.bottom = buried;
        this.log(`庄家 ${d.name} 扣下 6 张底牌（底牌不能扣分）。`);
        this.ui.render(this);
    }

    /* ==================== 出牌阶段 ==================== */

    async playPhase() {
        let leader = this.dealer; // 第一轮由庄家开始
        while (this.players.some(p => p.hand.length > 0)) {
            const winner = await this.playTrick(leader);
            leader = winner;
        }
    }

    async playTrick(leader) {
        this.trick = [];
        this.lead = null;
        this.trickNo++;
        this.curLeader = leader;
        this.ui.clearTable();

        for (let k = 0; k < 4; k++) {
            const i = (leader + k) % 4;
            const p = this.players[i];
            if (p.hand.length === 0) continue;

            if (k === 0) {
                await this.doLead(p);
            } else {
                await this.doFollow(p);
            }
            this.ui.render(this);
            await delay((p.isHuman ? 150 : 550) * speedMult());
        }

        const winner = trickWinner(this.trick, this.lead, this.ctx);
        const pts = this.trick.reduce((s, t) => s + totalPoints(t.cards), 0);
        const winTeam = TEAM_OF[winner];
        if (winTeam === this.defenderTeam() && pts > 0) {
            this.defenderPoints += pts;
            this.scoreLog.push({ no: this.trickNo, who: this.players[winner].name, pts });
            this.log(`${this.players[winner].name} 赢下本轮，闲家方得 ${pts} 分（累计 ${this.defenderPoints} 分）。`, 'score');
        } else {
            this.log(`${this.players[winner].name} 赢下本轮${pts > 0 ? `（${pts} 分归庄家方，不计入闲家）` : ''}。`);
        }
        for (const t of this.trick) this.playedCards.push(...t.cards);
        this.ui.render(this);
        this.ui.markWinner(winner);
        await delay(1100 * speedMult());
        this.ui.clearTable();
        return winner;
    }

    otherHands(exceptIdx) {
        return this.players.filter(p => p.idx !== exceptIdx).map(p => p.hand);
    }

    async doLead(p) {
        let selected, res;
        if (p.isHuman || p.remote) {
            while (true) {
                selected = await this.ui.askPlay(p, this, true);
                res = validateLead(selected, p.hand, this.ctx, this.otherHands(p.idx));
                if (res.ok) break;
                this.ui.toast(res.msg);
            }
        } else {
            selected = await AI.chooseLead(p.hand, this.ctx, this.otherHands(p.idx), this, p.idx);
            res = validateLead(selected, p.hand, this.ctx, this.otherHands(p.idx));
        }

        // 甩牌失败：重新出误甩牌中最小的牌
        if (res.fail) {
            const pc = res.fail.penaltyCard;
            this.log(`${p.name} 甩牌失败（所甩非最大牌）！按规则改出其中最小的 ${cardText(pc)}。`, 'important');
            selected = [pc];
            res = { ok: true, type: 'single', group: cardGroup(pc, this.ctx) };
        }

        for (const c of selected) p.hand.splice(p.hand.indexOf(c), 1);
        this.lead = { type: res.type, group: res.group, count: selected.length, gang: res.gang || null };
        this.trick.push({ playerIdx: p.idx, cards: selected, beatGang: null });

        const typeName = { single: '', throw: '【甩牌】', trueGang: '【真杠】', fakeGang: '【假杠】' }[res.type];
        this.log(`${p.name} 领出${typeName}：${selected.map(cardText).join(' ')}`);
    }

    async doFollow(p) {
        let selected, res;
        if (p.isHuman || p.remote) {
            while (true) {
                selected = await this.ui.askPlay(p, this, false);
                res = validateFollow(selected, p.hand, this.lead, this.ctx);
                if (res.ok) break;
                this.ui.toast(res.msg);
            }
        } else {
            const partner = (p.idx + 2) % 4;
            selected = await AI.chooseFollow(p.hand, this.trick, this.lead, this.ctx, p.idx, partner, this);
            res = validateFollow(selected, p.hand, this.lead, this.ctx);
            if (!res.ok) { // 兜底：AI 结果非法时按最小合法方式跟牌
                selected = this.fallbackFollow(p);
                res = validateFollow(selected, p.hand, this.lead, this.ctx);
            }
        }
        for (const c of selected) p.hand.splice(p.hand.indexOf(c), 1);
        this.trick.push({ playerIdx: p.idx, cards: selected, beatGang: res.beatGang || null });
        this.log(`${p.name} 出：${selected.map(cardText).join(' ')}`);
    }

    /** 最小合法跟牌（兜底） */
    fallbackFollow(p) {
        const n = this.lead.count;
        const ctx = this.ctx;
        const bySmall = (a, b) => strengthInGroup(a, ctx) - strengthInGroup(b, ctx);
        let first, rest;
        if (this.lead.type === 'trueGang') {
            first = p.hand.filter(c => isTrump(c, ctx)).sort(bySmall);
            rest = p.hand.filter(c => !isTrump(c, ctx)).sort(bySmall);
        } else if (this.lead.type === 'fakeGang') {
            first = p.hand.filter(c => !isTrump(c, ctx)).sort(bySmall);
            rest = p.hand.filter(c => isTrump(c, ctx)).sort(bySmall);
        } else {
            first = p.hand.filter(c => cardGroup(c, ctx) === this.lead.group).sort(bySmall);
            rest = p.hand.filter(c => cardGroup(c, ctx) !== this.lead.group).sort(bySmall);
        }
        return [...first, ...rest].slice(0, n);
    }

    /* ==================== 结算 ==================== */

    async settlePhase() {
        const F = this.defenderPoints;
        const dTeam = TEAM_OF[this.dealer];
        const fTeam = this.defenderTeam();
        const dealers = this.players.filter(p => p.team === dTeam).map(p => p.idx);
        const defenders = this.players.filter(p => p.team === fTeam).map(p => p.idx);
        const nextOfDealer = (this.dealer + 1) % 4;

        let text, nextDealer;
        this.tributePlan = [];

        if (F === 0) {
            text = `闲家方得 0 分：闲家方双进贡庄家方！庄家 ${this.players[this.dealer].name} 连庄。`;
            nextDealer = this.dealer;
            this.tributePlan = [
                { from: defenders[0], to: dealers[0] },
                { from: defenders[1], to: dealers[1] },
            ];
            this.teamWins[dTeam]++;
        } else if (F < 40) {
            text = `闲家方得 ${F} 分（不足 40 分）：庄家保台，${this.players[this.dealer].name} 连庄。`;
            nextDealer = this.dealer;
            this.teamWins[dTeam]++;
        } else if (F < 60) {
            text = `闲家方得 ${F} 分（≥40 分）：庄家下台！由庄家下家 ${this.players[nextOfDealer].name} 当庄。`;
            nextDealer = nextOfDealer;
            this.teamWins[fTeam]++;
        } else if (F < 80) {
            text = `闲家方得 ${F} 分（≥60 分）：庄家下台并进贡上庄人 ${this.players[nextOfDealer].name}！`;
            nextDealer = nextOfDealer;
            this.tributePlan = [{ from: this.dealer, to: nextOfDealer }];
            this.teamWins[fTeam]++;
        } else {
            text = `闲家方得 ${F} 分（≥80 分）：庄家方双进贡闲家方！由 ${this.players[nextOfDealer].name} 当庄。`;
            nextDealer = nextOfDealer;
            this.tributePlan = [
                { from: dealers[0], to: defenders[0] },
                { from: dealers[1], to: defenders[1] },
            ];
            this.teamWins[fTeam]++;
        }

        this.log(text, 'important');
        this.nextDealer = nextDealer;
        await this.ui.showSettlement(this, text);
        this.dealer = nextDealer;
        this.saveRecord();
        await this.playHand();
    }
}
