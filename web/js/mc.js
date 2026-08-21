/**
 * mc.js —— 蒙特卡洛推演决策（方案 A：无需训练）
 * 思路：对"其他三家手牌 + 底牌"做随机补全，用启发式策略快速打完剩余牌局，
 *       对每个候选动作统计"本队最终收益"的均值，取最优者。
 * 仅依赖 cards.js / rules.js；推演策略默认用 AI 的启发式分支。
 */
'use strict';

const MC = {
    rollouts: 40, // 每个候选动作的推演次数（越大越强越慢）
    scorer: null, // 方案 B 模型打分器（设置后跳过 rollout，直接给候选打分）
    lastValues: null, // 最近一次 evalCandidates 的每候选估值（sign*defPts 均值，供数据记录）
    lastSign: 1,

    /* ==================== 隐藏牌补全 ==================== */

    /**
     * 生成未知牌的随机布局（仅用公开信息）。
     * 返回 { unknown(洗牌后的未知牌面), fan(已亮三五反牌面), seen }
     */
    makeUnknown(game, myIdx) {
        const ctx = game.ctx;
        const seen = new Set();
        const mark = c => seen.add(c.suit + '|' + c.rank);
        game.players[myIdx].hand.forEach(mark);
        game.playedCards.forEach(mark);
        for (const t of game.trick) t.cards.forEach(mark);

        // 已亮三五反的牌面属公开信息（只读取亮牌属性，不读取隐藏牌其他信息）
        const fan = [];
        for (const p of game.players) for (const c of p.hand) {
            if (ctx.fan5Ids.has(c.id)) fan.push({ suit: c.suit, rank: c.rank, k: 5 });
            else if (ctx.fan3Ids.has(c.id)) fan.push({ suit: c.suit, rank: c.rank, k: 3 });
        }

        // 未知牌面 = 全副 54 张 - 已知
        const unknown = [];
        for (const s of SUITS) for (const r of RANKS) if (!seen.has(s + '|' + r)) unknown.push({ suit: s, rank: r });
        if (!seen.has('joker|BJ')) unknown.push({ suit: 'joker', rank: 'BJ' });
        if (!seen.has('joker|SJ')) unknown.push({ suit: 'joker', rank: 'SJ' });
        for (let i = unknown.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [unknown[i], unknown[j]] = [unknown[j], unknown[i]];
        }
        return { unknown, fan, seen };
    },

    /** 由未知牌布局构建其他三家手牌 + ctx2（牌对象可共享，数组每次使用前需拷贝） */
    buildWorld(game, myIdx, { unknown, fan, seen }) {
        const ctx = game.ctx;
        let uid = 1000000 + Math.floor(Math.random() * 1000000);
        const mk = d => ({ id: ++uid, suit: d.suit, rank: d.rank, fromTribute: false });
        const others = [[], [], [], []];
        let k = 0;
        for (let i = 0; i < 4; i++) {
            if (i === myIdx) continue;
            const n = game.players[i].hand.length;
            for (let x = 0; x < n; x++) others[i].push(mk(unknown[k++]));
        }
        const bottom = unknown.slice(k).map(mk);

        // 重建 ctx：隐藏区的亮牌用新 id 登记
        const f5 = new Set(ctx.fan5Ids), f3 = new Set(ctx.fan3Ids);
        const allClones = others[0].concat(others[1], others[2], others[3], bottom);
        for (const f of fan) {
            if (seen.has(f.suit + '|' + f.rank)) continue; // 已知牌面的亮牌 id 已在 ctx 中
            const clone = allClones.find(c => c.suit === f.suit && c.rank === f.rank);
            if (clone) (f.k === 5 ? f5 : f3).add(clone.id);
        }
        return { others, ctx2: makeRuleCtx(ctx.trumpSuit, f5, f3) };
    },

    /** 生成一个随机世界（共用随机数：同一决策的所有候选共用同一批 world 做配对比较，大幅降方差） */
    prep(game, myIdx) {
        return this.buildWorld(game, myIdx, this.makeUnknown(game, myIdx));
    },

    /* ==================== 候选动作枚举 ==================== */

    leadCandidates(hand, ctx) {
        const cands = [];
        for (const g of findTrueGangs(hand, ctx)) cands.push(g);
        for (const g of findFakeGangs(hand, ctx)) cands.push(g);
        const groups = {};
        for (const c of hand) {
            const g = cardGroup(c, ctx);
            (groups[g] = groups[g] || []).push(c);
        }
        for (const g in groups) {
            const arr = groups[g].slice().sort((a, b) => strengthInGroup(b, ctx) - strengthInGroup(a, ctx));
            for (const c of arr) cands.push([c]);                 // 单张
            for (let k = 2; k <= arr.length; k++) cands.push(arr.slice(0, k)); // 顶 k 张甩牌
        }
        return this.dedup(cands);
    },

    followCandidates(hand, trick, lead, ctx, myIdx, partnerIdx) {
        const n = lead.count;
        const cands = [];
        const bySmall = (a, b) => strengthInGroup(a, ctx) - strengthInGroup(b, ctx);
        const trumps = hand.filter(c => isTrump(c, ctx)).sort(bySmall);
        const sides = hand.filter(c => !isTrump(c, ctx)).sort(bySmall);

        if (lead.type === 'trueGang' || lead.type === 'fakeGang') {
            for (const g of findTrueGangs(hand, ctx)) {
                if (lead.type === 'fakeGang' || asTrueGang(g, ctx).order > lead.gang.order) cands.push(g);
            }
            cands.push(this.legalFollow(hand, lead, ctx));                       // 保守添牌
            const feed = hand.slice().sort((a, b) => cardPoints(b) - cardPoints(a) || bySmall(a, b));
            cands.push(this.legalFollowFrom(feed, lead, ctx));                   // 送分添牌
        } else if (lead.type === 'throw') {
            const inG = hand.filter(c => cardGroup(c, ctx) === lead.group).sort(bySmall);
            const outG = hand.filter(c => cardGroup(c, ctx) !== lead.group);
            if (inG.length >= n) {
                cands.push(inG.slice(0, n));
                cands.push(inG.slice().sort((a, b) => cardPoints(b) - cardPoints(a) || bySmall(a, b)).slice(0, n));
            } else {
                cands.push(this.legalFollow(hand, lead, ctx));
                const feed = outG.slice().sort((a, b) => cardPoints(b) - cardPoints(a) || bySmall(a, b));
                cands.push([...inG, ...feed].slice(0, n)); // 组内全跟 + 送分填充
            }
            // 全主毙甩牌
            if (inG.length === 0 && lead.group !== 'trump' && trumps.length >= n) {
                const ruff = trumps.slice(0, n - 1);
                const cand = [...ruff, trumps[trumps.length - 1]];
                const test = { playerIdx: myIdx, cards: cand };
                if (trickWinner([...trick, test], lead, ctx) === myIdx) cands.push(cand);
            }
        } else {
            const inG = hand.filter(c => cardGroup(c, ctx) === lead.group).sort(bySmall);
            for (const c of inG) cands.push([c]);
            // 最小/最省的主牌毙牌
            const winCard = trick.length ? trick.reduce((w, p) =>
                beatsCard(w.cards[0], p.cards[0], ctx) ? p : w, trick[0]).cards[0] : null;
            if (winCard && lead.group !== 'trump') {
                const ruff = trumps.find(c => beatsCard(winCard, c, ctx));
                if (ruff) cands.push([ruff]);
            }
            cands.push([hand.slice().sort((a, b) => (cardPoints(a) > 0) - (cardPoints(b) > 0) || bySmall(a, b))[0]]);
        }
        return this.dedup(cands).filter(cs => cs.length > 0 && cs.length <= hand.length);
    },

    /** 构造一个合法跟牌（组内优先，不足补其他） */
    legalFollow(hand, lead, ctx) {
        return this.legalFollowFrom(
            hand.slice().sort((a, b) => strengthInGroup(a, ctx) - strengthInGroup(b, ctx)), lead, ctx);
    },

    legalFollowFrom(order, lead, ctx) {
        const n = lead.count;
        const pick = [];
        if (lead.type === 'trueGang') {
            for (const c of order) if (pick.length < n && isTrump(c, ctx)) pick.push(c);
            for (const c of order) if (pick.length < n && !pick.includes(c)) pick.push(c);
        } else if (lead.type === 'fakeGang') {
            for (const c of order) if (pick.length < n && !isTrump(c, ctx)) pick.push(c);
            for (const c of order) if (pick.length < n && !pick.includes(c)) pick.push(c);
        } else {
            const inG = order.filter(c => cardGroup(c, ctx) === lead.group);
            const outG = order.filter(c => cardGroup(c, ctx) !== lead.group);
            for (const c of inG) if (pick.length < n) pick.push(c);
            for (const c of outG) if (pick.length < n) pick.push(c);
        }
        return pick.slice(0, n);
    },

    dedup(cands) {
        const seen = new Set(), res = [];
        for (const cs of cands) {
            const key = cs.map(c => c.id).sort((a, b) => a - b).join(',');
            if (cs.length === 0 || seen.has(key)) continue;
            seen.add(key);
            res.push(cs);
        }
        return res;
    },

    /* ==================== 推演 ==================== */

    /** 固定我的一手后，在给定随机世界 world 中把整局打完，返回闲家方最终得分 */
    async oneRollout(game, myIdx, cand, curTrick, curLead, defTeam, world) {
        const ctx2 = world.ctx2;
        const full = game.players[myIdx].hand;
    
        // 领出时若“甩牌失败”，真实对局会改出最小牌，推演保持一致
        let effCards = cand, leadInfo = curLead ? { ...curLead } : null;
        if (!curLead) {
            const others = world.others.filter((_, x) => x !== myIdx);
            let res = validateLead(cand, full, ctx2, others);
            if (!res.ok) { effCards = [cand[0]]; res = { ok: true, type: 'single', group: cardGroup(effCards[0], ctx2) }; }
            if (res.fail) { effCards = [res.fail.penaltyCard]; res = { type: 'single', group: res.group }; }
            leadInfo = { type: res.type, group: res.group, count: effCards.length, gang: res.gang || null };
        }
        const hands = [world.others[0].slice(), world.others[1].slice(), world.others[2].slice(), world.others[3].slice()];
        hands[myIdx] = full.filter(c => !effCards.includes(c));
    
        const trick = (curTrick || []).map(t => ({ playerIdx: t.playerIdx, cards: t.cards, beatGang: t.beatGang }));
        if (curLead) {
            const vf = validateFollow(effCards, full, curLead, ctx2);
            trick.push({ playerIdx: myIdx, cards: effCards, beatGang: vf.beatGang || null });
            if (!vf.ok) { // 候选不合法（不应发生），回退合法跟牌
                const fix = this.legalFollow(full, curLead, ctx2);
                trick[trick.length - 1] = { playerIdx: myIdx, cards: fix, beatGang: null };
                hands[myIdx] = full.filter(c => !fix.includes(c));
            }
        } else {
            trick.push({ playerIdx: myIdx, cards: effCards, beatGang: null });
        }
    
        return this.playOut(hands, ctx2, defTeam, game.defenderPoints, trick, leadInfo, (myIdx + 1) % 4);
    },

    /** 从当前轮状态打到终局，返回闲家方总得分 */
    async playOut(hands, ctx, defTeam, defPts, trick, lead, nextIdx) {
        let cur = nextIdx;
        for (let guard = 0; guard < 40; guard++) {
            // 打完当前轮
            for (let k = 0; k < 4; k++) {
                if (trick.length >= 4) break;
                const i = (cur + k) % 4;
                const hand = hands[i];
                if (hand.length === 0) continue;
                let cards, vf;
                if (!lead) {
                    const others = hands.filter((_, x) => x !== i);
                    cards = await this.policy.chooseLead(hand, ctx, others);
                    let res = validateLead(cards, hand, ctx, others);
                    if (!res.ok) { cards = [hand[0]]; res = { ok: true, type: 'single', group: cardGroup(cards[0], ctx) }; }
                    if (res.fail) { cards = [res.fail.penaltyCard]; res = { type: 'single', group: res.group }; }
                    lead = { type: res.type, group: res.group, count: cards.length, gang: res.gang || null };
                } else {
                    cards = await this.policy.chooseFollow(hand, trick, lead, ctx, i, (i + 2) % 4);
                    vf = validateFollow(cards, hand, lead, ctx);
                    if (!vf.ok) { cards = this.legalFollow(hand, lead, ctx); vf = {}; }
                }
                for (const c of cards) hand.splice(hand.indexOf(c), 1);
                trick.push({ playerIdx: i, cards, beatGang: (vf && vf.beatGang) || null });
            }
            const winner = trickWinner(trick, lead, ctx);
            if (TEAM_OF[winner] === defTeam) defPts += totalPoints(trick.reduce((s, t) => s.concat(t.cards), []));
            if (hands.every(h => h.length === 0)) break;
            trick = []; lead = null; cur = winner;
        }
        return defPts;
    },

    policy: null, // 推演策略，外部注入（AI 的启发式分支）

    /* ==================== 决策入口 ==================== */

    async chooseLeadMC(game, myIdx) {
        const hand = game.players[myIdx].hand;
        // 注入启发式选择，保证 MC 不差于启发式（策略改进单调性）
        const heur = this.policy.heurLead(hand, game.ctx, game.otherHands(myIdx));
        const cands = this.dedup(this.leadCandidates(hand, game.ctx).concat([heur]));
        return this.evalCandidates(game, myIdx, cands, null, null);
    },

    async chooseFollowMC(game, myIdx) {
        const hand = game.players[myIdx].hand;
        const partner = (myIdx + 2) % 4;
        const heur = this.policy.heurFollow(hand, game.trick, game.lead, game.ctx, myIdx, partner);
        const cands = this.dedup(this.followCandidates(hand, game.trick, game.lead, game.ctx, myIdx, partner).concat([heur]));
        return this.evalCandidates(game, myIdx, cands, game.trick, game.lead);
    },

    async evalCandidates(game, myIdx, cands, curTrick, curLead) {
        if (cands.length === 1) return cands[0];
        if (this.scorer) return this.scorer(game, myIdx, cands, curTrick, curLead);
        const defTeam = 1 - TEAM_OF[game.dealer];
        const sign = TEAM_OF[myIdx] === defTeam ? 1 : -1;
        this.lastSign = sign;
        // 共用随机数：所有候选在同一批世界上配对比较
        const worlds = [];
        for (let r = 0; r < this.rollouts; r++) worlds.push(this.prep(game, myIdx));
        let best = cands[0], bestV = -Infinity;
        const vals = new Array(cands.length);
        for (let ci = 0; ci < cands.length; ci++) {
            let sum = 0;
            for (let r = 0; r < this.rollouts; r++) {
                sum += sign * await this.oneRollout(game, myIdx, cands[ci], curTrick, curLead, defTeam, worlds[r]);
            }
            const v = sum / this.rollouts;
            vals[ci] = v;
            if (v > bestV) { bestV = v; best = cands[ci]; }
            if (ci % 6 === 5) await new Promise(res => setTimeout(res, 0)); // 让出 UI
        }
        this.lastValues = vals;
        return best;
    },
};

MC.policy = (typeof AI !== 'undefined') ? AI : null;
