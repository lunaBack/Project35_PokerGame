/**
 * rules.js —— 三五反规则引擎
 * 依据《三五反规则.pdf》实现：
 *  - 主牌等级（方片5 > 五反 > 三反 > 大王 > 小王 > 黑桃Q > 主J > 副J > 主2 > 副2 > 主花色 A..3）
 *  - 副牌等级 A > K > Q > 10 > 9 > 8 > 7 > 6 > 5 > 4 > 3
 *  - 真杠 / 假杠、甩牌 / 甩牌失败、毙牌 / 盖毙、跟牌约束
 */
'use strict';

/** 副牌点数序（大到小索引越大越大） */
const SIDE_ORDER = { '3': 0, '4': 1, '5': 2, '6': 3, '7': 4, '8': 5, '9': 6, '10': 7, 'Q': 8, 'K': 9, 'A': 10 };
/** 真杠大小序：A 最大，2 最小 */
const GANG_ORDER = { '2': 0, '3': 1, '4': 2, '5': 3, '6': 4, '7': 5, '8': 6, '9': 7, '10': 8, 'J': 9, 'Q': 10, 'K': 11, 'A': 12 };

/**
 * ctx 规则上下文：
 * { trumpSuit: 'spade'|'heart'|'club'|'diamond',
 *   fan5Ids: Set<cardId>  亮出的五反牌,
 *   fan3Ids: Set<cardId>  亮出的三反牌 }
 */
function makeRuleCtx(trumpSuit, fan5Ids, fan3Ids) {
    return {
        trumpSuit,
        fan5Ids: fan5Ids || new Set(),
        fan3Ids: fan3Ids || new Set(),
    };
}

/** 是否主牌 */
function isTrump(card, ctx) {
    if (card.suit === 'joker') return true;
    if (card.suit === 'diamond' && card.rank === '5') return true; // 方片5
    if (card.suit === 'spade' && card.rank === 'Q') return true;   // 黑桃Q 常主
    if (card.rank === 'J' || card.rank === '2') return true;       // 所有 J / 2 为常主
    if (card.suit === ctx.trumpSuit) return true;                  // 主花色
    if (ctx.fan5Ids.has(card.id) || ctx.fan3Ids.has(card.id)) return true; // 三五反亮出的牌
    return false;
}

/**
 * 主牌等级（数值越大越强）。非主牌返回 -1。
 * 同级牌（副J之间、副2之间、三五反同组之间）等级相同 → 比牌时"先出者大"。
 */
function trumpLevel(card, ctx) {
    if (card.suit === 'diamond' && card.rank === '5') return 1000; // 方片5 最大
    if (ctx.fan5Ids.has(card.id)) return 950;                      // 五反
    if (ctx.fan3Ids.has(card.id)) return 940;                      // 三反（五反大于三反）
    if (card.rank === 'BJ') return 900;                            // 大王
    if (card.rank === 'SJ') return 890;                            // 小王
    if (card.suit === 'spade' && card.rank === 'Q') return 880;    // 黑桃Q
    if (card.rank === 'J') return card.suit === ctx.trumpSuit ? 870 : 860; // 主J / 副J
    if (card.rank === '2') return card.suit === ctx.trumpSuit ? 850 : 840; // 主2 / 副2
    if (card.suit === ctx.trumpSuit) return 700 + SIDE_ORDER[card.rank];   // 主花色普通牌
    return -1;
}

/** 牌所属"花色组"：主牌统一归为 'trump'，副牌为其花色 */
function cardGroup(card, ctx) {
    return isTrump(card, ctx) ? 'trump' : card.suit;
}

/** 组内强度（主牌用 trumpLevel，副牌用点数序） */
function strengthInGroup(card, ctx) {
    const t = trumpLevel(card, ctx);
    return t >= 0 ? t : SIDE_ORDER[card.rank];
}

/**
 * b 是否严格大过 a（a 先出）。同级"先出者大"，故必须严格大于。
 * 跨组：主牌毙副牌为大；副牌不可能大过主牌；不同副牌花色互不比较（添牌不大）。
 */
function beatsCard(a, b, ctx) {
    const ga = cardGroup(a, ctx), gb = cardGroup(b, ctx);
    if (ga === gb) return strengthInGroup(b, ctx) > strengthInGroup(a, ctx);
    if (gb === 'trump') return true;  // 毙牌
    return false;
}

/**
 * 手牌排序：主牌在前按等级从大到小；副牌按 黑桃→红桃→梅花→方片、点数从小到大
 */
function sortHand(cards, ctx) {
    const suitIdx = { spade: 0, heart: 1, club: 2, diamond: 3 };
    return cards.slice().sort((a, b) => {
        const ta = isTrump(a, ctx), tb = isTrump(b, ctx);
        if (ta !== tb) return ta ? -1 : 1;
        if (ta) return trumpLevel(b, ctx) - trumpLevel(a, ctx);
        if (a.suit !== b.suit) return suitIdx[a.suit] - suitIdx[b.suit];
        return SIDE_ORDER[a.rank] - SIDE_ORDER[b.rank];
    });
}

/* ============================ 真杠 / 假杠 ============================ */

/**
 * 判断 4 张牌是否构成真杠：四张相同数字，且均不是进贡还贡所得、
 * 且不含已亮的三五反牌。四个Q可作真杠。
 */
function asTrueGang(cards, ctx) {
    if (cards.length !== 4) return null;
    const r = cards[0].rank;
    if (r === 'BJ' || r === 'SJ') return null;
    for (const c of cards) {
        if (c.rank !== r) return null;
        if (c.fromTribute) return null; // 进贡还贡的牌不能构成真假杠
        if (ctx.fan5Ids.has(c.id) || ctx.fan3Ids.has(c.id)) return null; // 亮后的3/5不能构成杠
    }
    return { type: 'trueGang', rank: r, order: GANG_ORDER[r] };
}

/**
 * 判断 4 张牌是否构成假杠：黑桃Q + 三张相同数字的牌。
 */
function asFakeGang(cards, ctx) {
    if (cards.length !== 4) return null;
    const sq = cards.find(c => c.suit === 'spade' && c.rank === 'Q');
    if (!sq || sq.fromTribute) return null;
    const rest = cards.filter(c => c !== sq);
    const r = rest[0].rank;
    if (r === 'BJ' || r === 'SJ') return null;
    for (const c of rest) {
        if (c.rank !== r) return null;
        if (c.fromTribute) return null;
        if (ctx.fan5Ids.has(c.id) || ctx.fan3Ids.has(c.id)) return null;
    }
    return { type: 'fakeGang', rank: r, order: GANG_ORDER[r] };
}

/** 在手牌中找出所有可组真杠的点数 */
function findTrueGangs(hand, ctx) {
    const byRank = {};
    for (const c of hand) {
        if (c.rank === 'BJ' || c.rank === 'SJ') continue;
        if (c.fromTribute) continue;
        if (ctx.fan5Ids.has(c.id) || ctx.fan3Ids.has(c.id)) continue;
        (byRank[c.rank] = byRank[c.rank] || []).push(c);
    }
    const res = [];
    for (const r in byRank) if (byRank[r].length >= 4) res.push(byRank[r].slice(0, 4));
    return res;
}

/** 在手牌中找出所有可组假杠的组合（黑桃Q + 三同点） */
function findFakeGangs(hand, ctx) {
    const sq = hand.find(c => c.suit === 'spade' && c.rank === 'Q' && !c.fromTribute);
    if (!sq) return [];
    const byRank = {};
    for (const c of hand) {
        if (c === sq || c.rank === 'BJ' || c.rank === 'SJ') continue;
        if (c.fromTribute) continue;
        if (ctx.fan5Ids.has(c.id) || ctx.fan3Ids.has(c.id)) continue;
        if (c.suit === 'spade' && c.rank === 'Q') continue;
        (byRank[c.rank] = byRank[c.rank] || []).push(c);
    }
    const res = [];
    for (const r in byRank) if (byRank[r].length >= 3) res.push([sq, ...byRank[r].slice(0, 3)]);
    return res;
}

/* ============================ 首家出牌（领出）校验 ============================ */

/**
 * 校验首家领出。
 * @param selected 选中的牌
 * @param hand     该玩家手牌
 * @param ctx      规则上下文
 * @param otherHands 其余三家手牌数组（用于甩牌失败判定："还在手牌中"）
 * @returns {ok, type:'single'|'throw'|'trueGang'|'fakeGang', gang?, group?,
 *           fail?:{penaltyCard}}  甩牌失败时返回需改出的最小牌
 */
function validateLead(selected, hand, ctx, otherHands) {
    if (selected.length === 0) return { ok: false, msg: '请选择要出的牌' };

    if (selected.length === 1) {
        return { ok: true, type: 'single', group: cardGroup(selected[0], ctx) };
    }

    // 4 张时优先判断真杠 / 假杠
    if (selected.length === 4) {
        const tg = asTrueGang(selected, ctx);
        if (tg) return { ok: true, type: 'trueGang', gang: tg, group: 'gang' };
        const fg = asFakeGang(selected, ctx);
        if (fg) return { ok: true, type: 'fakeGang', gang: fg, group: 'gang' };
    }

    // 甩牌：必须同一花色组
    const g = cardGroup(selected[0], ctx);
    for (const c of selected) {
        if (cardGroup(c, ctx) !== g) return { ok: false, msg: '甩牌必须为同一花色（主牌算同一花色）' };
    }
    // 甩牌失败判定：所甩每张牌都必须大过其他玩家手中同组的所有牌
    let maxOut = -1;
    for (const h of otherHands) {
        for (const c of h) {
            if (cardGroup(c, ctx) === g) maxOut = Math.max(maxOut, strengthInGroup(c, ctx));
        }
    }
    const bad = selected.filter(c => strengthInGroup(c, ctx) <= maxOut);
    if (bad.length > 0) {
        // 甩牌失败：改出误甩牌中最小的一张
        let penalty = selected[0];
        for (const c of selected) {
            if (strengthInGroup(c, ctx) < strengthInGroup(penalty, ctx)) penalty = c;
        }
        return { ok: true, type: 'single', group: g, fail: { penaltyCard: penalty } };
    }
    return { ok: true, type: 'throw', group: g };
}

/* ============================ 跟牌校验 ============================ */

/**
 * 跟牌合法性校验。
 * @param selected 选中的牌
 * @param hand     跟牌者手牌
 * @param lead     {type, group, count, gang} 首家领出信息
 */
function validateFollow(selected, hand, lead, ctx) {
    const n = lead.count;
    if (selected.length !== n) return { ok: false, msg: `本轮须出 ${n} 张牌` };

    if (lead.type === 'trueGang') {
        // 可用更大的真杠盖过；较小的真杠若满足添牌要求则按普通添牌处理
        const tg = asTrueGang(selected, ctx);
        if (tg && tg.order > lead.gang.order) return { ok: true, beatGang: tg };
        // 否则：只能添主牌，若无主牌则添副牌
        const trumpsInHand = hand.filter(c => isTrump(c, ctx)).length;
        const needTrump = Math.min(4, trumpsInHand);
        const selTrump = selected.filter(c => isTrump(c, ctx)).length;
        if (selTrump < needTrump) return { ok: false, msg: `首家出真杠：须添主牌（至少 ${needTrump} 张主牌）` };
        return { ok: true };
    }

    if (lead.type === 'fakeGang') {
        // 有真杠的玩家可用真杠大过假杠
        const tg = asTrueGang(selected, ctx);
        if (tg) return { ok: true, beatGang: tg };
        // 否则：只能添副牌，若无副牌则贴主牌
        const sideInHand = hand.filter(c => !isTrump(c, ctx)).length;
        const needSide = Math.min(4, sideInHand);
        const selSide = selected.filter(c => !isTrump(c, ctx)).length;
        if (selSide < needSide) return { ok: false, msg: `首家出假杠：须添副牌（至少 ${needSide} 张副牌）` };
        return { ok: true };
    }

    // 单张 / 甩牌：有同花色（组）必须跟够；首家出主牌时即"有主必出主、不足才可用副牌充数"
    const inGroupHand = hand.filter(c => cardGroup(c, ctx) === lead.group).length;
    const mustFollow = Math.min(n, inGroupHand);
    const selInGroup = selected.filter(c => cardGroup(c, ctx) === lead.group).length;
    if (selInGroup < mustFollow) {
        if (lead.group === 'trump') {
            return { ok: false, msg: `首家出主牌：有主牌必须出主牌（还需 ${mustFollow - selInGroup} 张，主牌不足才可用副牌充数）` };
        }
        return { ok: false, msg: `有${SUIT_NAME[lead.group]}时必须跟${SUIT_NAME[lead.group]}（还需 ${mustFollow - selInGroup} 张）` };
    }
    return { ok: true };
}

/* ============================ 一轮比牌 ============================ */

/**
 * 判定一轮的赢家。
 * @param plays [{playerIdx, cards, beatGang?}] 按出牌顺序
 * @param lead  {type, group, count, gang}
 * @returns 赢家 playerIdx
 */
function trickWinner(plays, lead, ctx) {
    // 杠牌轮：只有 beatGang（更大真杠 / 真杠盖假杠）能赢首家
    if (lead.type === 'trueGang' || lead.type === 'fakeGang') {
        let win = plays[0].playerIdx;
        let winOrder = lead.gang.order;
        let winIsTrue = lead.type === 'trueGang';
        for (let i = 1; i < plays.length; i++) {
            const bg = plays[i].beatGang;
            if (!bg) continue;
            // 真杠 > 假杠；同为真杠比点数
            if (!winIsTrue || bg.order > winOrder) {
                win = plays[i].playerIdx;
                winOrder = bg.order;
                winIsTrue = true;
            }
        }
        return win;
    }

    // 甩牌轮：首家为大，除非有人"毙甩牌"（无同花色 + 全部为主牌）；多家毙时盖毙比最大单张
    if (lead.type === 'throw') {
        let win = plays[0].playerIdx;
        let winRuffMax = -1; // 首家未被毙时为 -1
        if (lead.group === 'trump') return win; // 甩主牌无法被毙
        for (let i = 1; i < plays.length; i++) {
            const cs = plays[i].cards;
            const allTrump = cs.every(c => isTrump(c, ctx));
            if (!allTrump) continue;
            const mx = Math.max(...cs.map(c => trumpLevel(c, ctx)));
            if (mx > winRuffMax) { win = plays[i].playerIdx; winRuffMax = mx; } // 盖毙须严格更大（先出者大）
        }
        return win;
    }

    // 单张轮
    let winPlay = plays[0];
    for (let i = 1; i < plays.length; i++) {
        if (beatsCard(winPlay.cards[0], plays[i].cards[0], ctx)) winPlay = plays[i];
    }
    return winPlay.playerIdx;
}
