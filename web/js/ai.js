/**
 * ai.js —— AI 决策：亮主、亮三五反、扣底、领出、跟牌、进贡还贡
 */
'use strict';

const AI = {

    difficulty: 'normal', // 'easy' 简单 / 'normal' 普通
    setDifficulty(d) { this.difficulty = d === 'easy' ? 'easy' : 'normal'; },
    isEasy() { return this.difficulty === 'easy'; },

    /**
     * 亮主决策：手中有 2 时，评估该花色实力，够强则亮。
     * 返回要亮的 2 牌，或 null（不亮）。
     */
    chooseRevealTrump(hand, firstHand) {
        const twos = hand.filter(c => c.rank === '2' && c.suit !== 'joker');
        let best = null, bestScore = -1;
        for (const two of twos) {
            const suit = two.suit;
            // 该花色张数 + 常主实力
            const suitCnt = hand.filter(c => c.suit === suit && c.rank !== '2' && c.rank !== 'J').length;
            const bigTrump = hand.filter(c =>
                c.suit === 'joker' ||
                (c.suit === 'spade' && c.rank === 'Q') ||
                (c.suit === 'diamond' && c.rank === '5') ||
                c.rank === 'J').length;
            const score = suitCnt + bigTrump * 0.8;
            if (score > bestScore) { bestScore = score; best = two; }
        }
        // 首局抢亮意愿更强（当庄）；简单档更保守
        const threshold = (firstHand ? 4.5 : 5) + (this.isEasy() ? 1.5 : 0);
        return bestScore >= threshold ? best : null;
    },

    /** 三五反亮牌：恰好三张 3 或三张 5（非进贡牌）时总是亮（成为大主+免进贡） */
    chooseFanReveal(hand) {
        const res = [];
        for (const r of ['5', '3']) {
            const cs = hand.filter(c => c.rank === r && c.suit !== 'joker' && !c.fromTribute);
            if (cs.length === 3) res.push({ rank: r, cards: cs });
        }
        return res;
    },

    /** 庄家扣底：优先扣 非主、非分、短花色 的小牌（底牌不能扣分） */
    chooseBury(hand, ctx) {
        const nonPoint = hand.filter(c => cardPoints(c) === 0);
        const suitCnt = {};
        for (const c of hand) {
            if (!isTrump(c, ctx)) suitCnt[c.suit] = (suitCnt[c.suit] || 0) + 1;
        }
        const scored = nonPoint.map(c => {
            let s = strengthInGroup(c, ctx);
            if (isTrump(c, ctx)) s += 1000;            // 尽量不扣主
            else s += (suitCnt[c.suit] || 0) * 3;      // 短花色优先扣（断门以便毙牌）
            return { c, s };
        }).sort((a, b) => a.s - b.s);
        if (scored.length >= 6) return scored.slice(0, 6).map(x => x.c);
        // 极端情况：非分牌不足 6 张，只能补扣分值最小的分牌
        const picked = scored.map(x => x.c);
        const pointCards = hand.filter(c => cardPoints(c) > 0)
            .sort((a, b) => cardPoints(a) - cardPoints(b) || strengthInGroup(a, ctx) - strengthInGroup(b, ctx));
        for (const c of pointCards) { if (picked.length < 6) picked.push(c); }
        return picked.slice(0, 6);
    },

    /**
     * 领出决策。
     * @param unseen 每个花色组中"其他人手上"的最大强度 {group: maxStrength}
     */
    chooseLead(hand, ctx, otherHands) {
        // 1) 有真杠先出真杠
        const tgs = findTrueGangs(hand, ctx);
        if (tgs.length > 0) {
            tgs.sort((a, b) => GANG_ORDER[b[0].rank] - GANG_ORDER[a[0].rank]);
            return tgs[0];
        }
        // 2) 有假杠且主牌较多时出假杠（收对方副牌）
        const fgs = findFakeGangs(hand, ctx);
        const myTrumps = hand.filter(c => isTrump(c, ctx)).length;
        if (fgs.length > 0 && myTrumps >= 5) return fgs[0];

        // 其他人各组最大强度
        const maxOut = {};
        for (const h of otherHands) {
            for (const c of h) {
                const g = cardGroup(c, ctx);
                const s = strengthInGroup(c, ctx);
                if (!(g in maxOut) || s > maxOut[g]) maxOut[g] = s;
            }
        }
        // 3) 甩牌：同组中所有大过外面最大牌的牌 ≥2 张时甩出
        const groups = {};
        for (const c of hand) {
            const g = cardGroup(c, ctx);
            (groups[g] = groups[g] || []).push(c);
        }
        for (const g in groups) {
            const winners = groups[g].filter(c => strengthInGroup(c, ctx) > (maxOut[g] ?? -1));
            if (winners.length >= (this.isEasy() ? 3 : 2)) return winners;
        }
        // 4) 单张必胜牌
        for (const g in groups) {
            const winners = groups[g].filter(c => strengthInGroup(c, ctx) > (maxOut[g] ?? -1));
            if (winners.length === 1) return [winners[0]];
        }
        // 5) 出最短副牌花色的最小牌（尽量不送分）
        const side = hand.filter(c => !isTrump(c, ctx));
        const pool = side.length > 0 ? side : hand;
        const cnt = {};
        for (const c of pool) cnt[cardGroup(c, ctx)] = (cnt[cardGroup(c, ctx)] || 0) + 1;
        const sorted = pool.slice().sort((a, b) => {
            const pa = cardPoints(a) > 0 ? 1 : 0, pb = cardPoints(b) > 0 ? 1 : 0;
            if (pa !== pb) return pa - pb;
            const ca = cnt[cardGroup(a, ctx)], cb = cnt[cardGroup(b, ctx)];
            if (ca !== cb) return ca - cb;
            return strengthInGroup(a, ctx) - strengthInGroup(b, ctx);
        });
        return [sorted[0]];
    },

    /**
     * 跟牌决策。
     * @param trick 本轮已出 [{playerIdx, cards, beatGang?}]
     * @param lead  领出信息
     * @param myIdx 自己座位
     * @param partnerIdx 队友座位
     */
    chooseFollow(hand, trick, lead, ctx, myIdx, partnerIdx) {
        const n = lead.count;
        const winnerNow = trickWinner(trick, lead, ctx);
        const partnerWinning = winnerNow === partnerIdx;
        const trickPts = trick.reduce((s, p) => s + totalPoints(p.cards), 0);
        const isLast = trick.length === 3;

        const bySmall = (a, b) => strengthInGroup(a, ctx) - strengthInGroup(b, ctx);
        const smallestFirst = (cards) => cards.slice().sort(bySmall);
        // 垫牌优先级：非分小牌 → 分牌 → 大牌
        const discardOrder = (cards) => cards.slice().sort((a, b) => {
            const pa = cardPoints(a) > 0 ? 1 : 0, pb = cardPoints(b) > 0 ? 1 : 0;
            if (pa !== pb) return pa - pb;
            return bySmall(a, b);
        });
        // 给队友送分：分牌优先
        const feedOrder = (cards) => cards.slice().sort((a, b) => {
            const pa = cardPoints(a), pb = cardPoints(b);
            if (pa !== pb) return pb - pa;
            return bySmall(a, b);
        });

        /* ---------- 杠牌轮 ---------- */
        if (lead.type === 'trueGang' || lead.type === 'fakeGang') {
            // 尝试用真杠盖
            const tgs = findTrueGangs(hand, ctx);
            for (const g of tgs.sort((a, b) => GANG_ORDER[a[0].rank] - GANG_ORDER[b[0].rank])) {
                const cand = { playerIdx: myIdx, cards: g, beatGang: asTrueGang(g, ctx) };
                if (trickWinner([...trick, cand], lead, ctx) === myIdx) return g;
            }
            const trumps = hand.filter(c => isTrump(c, ctx));
            const sides = hand.filter(c => !isTrump(c, ctx));
            const pick = [];
            if (lead.type === 'trueGang') {
                // 添主牌，不足添副牌
                const feed = partnerWinning ? feedOrder : discardOrder;
                for (const c of feed(trumps)) if (pick.length < n) pick.push(c);
                for (const c of feed(sides)) if (pick.length < n) pick.push(c);
            } else {
                const feed = partnerWinning ? feedOrder : discardOrder;
                for (const c of feed(sides)) if (pick.length < n) pick.push(c);
                for (const c of feed(trumps)) if (pick.length < n) pick.push(c);
            }
            return pick;
        }

        const inGroup = hand.filter(c => cardGroup(c, ctx) === lead.group);
        const outGroup = hand.filter(c => cardGroup(c, ctx) !== lead.group);

        /* ---------- 甩牌轮 ---------- */
        if (lead.type === 'throw') {
            if (inGroup.length >= n) {
                // 只能跟组：队友赢则送分，否则垫小
                const order = partnerWinning ? feedOrder(inGroup) : discardOrder(inGroup);
                return order.slice(0, n);
            }
            // 无同组或不足：可尝试全主毙牌（简单档更保守，分多才毙）
            if (inGroup.length === 0 && lead.group !== 'trump' && !partnerWinning) {
                const trumps = hand.filter(c => isTrump(c, ctx));
                if (trumps.length >= n && (trickPts >= (this.isEasy() ? 20 : 10) || totalPoints(trick[0].cards) >= 10)) {
                    const ruff = smallestFirst(trumps).slice(0, n - 1);
                    // 最大一张需大过已有盖毙
                    const bigger = smallestFirst(trumps).filter(c => !ruff.includes(c));
                    const cand = [...ruff, bigger[bigger.length - 1]];
                    const test = { playerIdx: myIdx, cards: cand };
                    if (trickWinner([...trick, test], lead, ctx) === myIdx) return cand;
                }
            }
            // 添牌
            const pick = inGroup.slice();
            const filler = partnerWinning ? feedOrder(outGroup) : discardOrder(outGroup);
            for (const c of filler) if (pick.length < n) pick.push(c);
            return pick;
        }

        /* ---------- 单张轮 ---------- */
        if (inGroup.length > 0) {
            if (partnerWinning && !isLast) {
                return [feedOrder(inGroup)[0]]; // 队友已大，送分/垫小
            }
            if (partnerWinning && isLast) {
                return [feedOrder(inGroup)[0]];
            }
            // 尝试最小的能大过当前赢家的牌
            const winCard = trick.find(p => p.playerIdx === winnerNow).cards[0];
            const beat = smallestFirst(inGroup).find(c => beatsCard(winCard, c, ctx));
            if (beat && (trickPts >= 10 || isLast || strengthInGroup(beat, ctx) < 700 || cardPoints(beat) === 0)) {
                return [beat];
            }
            return [discardOrder(inGroup)[0]];
        }
        // 无同组：可毙牌（副牌轮 + 有主）；简单档只在高分轮才毙
        if (lead.group !== 'trump' && !partnerWinning) {
            const trumps = hand.filter(c => isTrump(c, ctx));
            if (trumps.length > 0) {
                const winCard = trick.find(p => p.playerIdx === winnerNow).cards[0];
                const ruff = smallestFirst(trumps).find(c => beatsCard(winCard, c, ctx));
                if (ruff && (trickPts >= (this.isEasy() ? 10 : 5) || isLast)) return [ruff];
            }
        }
        // 垫牌
        const order = partnerWinning ? feedOrder(hand) : discardOrder(hand);
        return [order[0]];
    },

    /** 进贡：手上最大的主牌；无主或主牌全是分牌则免（返回 null） */
    chooseTribute(hand, ctx) {
        const trumps = hand.filter(c => isTrump(c, ctx));
        if (trumps.length === 0) return null;
        const nonPointTrumps = trumps.filter(c => cardPoints(c) === 0);
        if (nonPointTrumps.length === 0) return null; // 只有有分值的主牌 → 免进贡
        return trumps.slice().sort((a, b) => trumpLevel(b, ctx) - trumpLevel(a, ctx))[0];
    },

    /** 还贡：所得贡牌和分牌之外的任意主牌（还最小的）；无可还主牌则还最小非分副牌 */
    chooseReturnTribute(hand, ctx) {
        const cand = hand.filter(c => isTrump(c, ctx) && !c.fromTribute && cardPoints(c) === 0);
        if (cand.length > 0) return cand.sort((a, b) => trumpLevel(a, ctx) - trumpLevel(b, ctx))[0];
        const side = hand.filter(c => !isTrump(c, ctx) && cardPoints(c) === 0);
        if (side.length > 0) return side.sort((a, b) => strengthInGroup(a, ctx) - strengthInGroup(b, ctx))[0];
        return hand.slice().sort((a, b) => strengthInGroup(a, ctx) - strengthInGroup(b, ctx))[0];
    },
};
