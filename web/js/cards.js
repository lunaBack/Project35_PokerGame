/**
 * cards.js —— 牌模型与牌组
 * 三五反：54 张牌（含大小王），四人两两对抗，每人 12 张，底牌 6 张
 */
'use strict';

const SUITS = ['spade', 'heart', 'club', 'diamond']; // 黑桃 红桃 梅花 方片
const SUIT_SYMBOL = { spade: '♠', heart: '♥', club: '♣', diamond: '♦' };
const SUIT_NAME = { spade: '黑桃', heart: '红桃', club: '梅花', diamond: '方片' };
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

let __cardUid = 0;

/**
 * 牌对象
 * suit: 'spade'|'heart'|'club'|'diamond'|'joker'
 * rank: '2'..'A' | 'BJ'(大王) | 'SJ'(小王)
 */
function makeCard(suit, rank) {
    return {
        id: ++__cardUid,
        suit,
        rank,
        fromTribute: false, // 进贡/还贡获得的牌（不能构成真假杠、三五反）
    };
}

/** 生成一副 54 张牌 */
function createDeck() {
    const deck = [];
    for (const s of SUITS) {
        for (const r of RANKS) deck.push(makeCard(s, r));
    }
    deck.push(makeCard('joker', 'BJ')); // 大王
    deck.push(makeCard('joker', 'SJ')); // 小王
    return deck;
}

/** 洗牌（Fisher-Yates） */
function shuffle(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

/** 牌的分值：5=5分，10/K=10分 */
function cardPoints(card) {
    if (card.rank === '5') return 5;
    if (card.rank === '10' || card.rank === 'K') return 10;
    return 0;
}

/** 一组牌的总分 */
function totalPoints(cards) {
    return cards.reduce((s, c) => s + cardPoints(c), 0);
}

/** 牌的显示文本 */
function cardText(card) {
    if (card.rank === 'BJ') return '大王';
    if (card.rank === 'SJ') return '小王';
    return SUIT_SYMBOL[card.suit] + card.rank;
}

/** 是否红色牌 */
function isRedCard(card) {
    if (card.rank === 'BJ') return true;
    if (card.rank === 'SJ') return false;
    return card.suit === 'heart' || card.suit === 'diamond';
}
