"""
游戏规则判断
"""

from typing import List, Optional, Tuple
from project35.card import Card, Suit, RANK_ORDER


class Rules:
    """游戏规则"""
    
    def __init__(self):
        self.trump_suit: Optional[Suit] = None
        self.sanfan_wufan: dict = {}
    
    def set_trump_suit(self, suit: Suit):
        """设置主牌花色"""
        self.trump_suit = suit
    
    def set_sanfan_wufan(self, sf_wf: dict):
        """设置三五反"""
        self.sanfan_wufan = sf_wf
    
    def is_trump(self, card: Card, player_idx: int = None) -> bool:
        """判断是否是主牌"""
        if card.suit == Suit.JOKER:
            return True
        if card.rank == 'Q' and card.suit == Suit.SPADE:
            return True  # 黑桃Q固定主牌
        if card.suit == Suit.DIAMOND and card.rank == '5':
            return True  # 方片5
        if self.trump_suit and card.suit == self.trump_suit:
            return True  # 主花色
        
        # 检查三反、五反（如果有亮三五反）
        if player_idx is not None and player_idx in self.sanfan_wufan:
            sf_type = self.sanfan_wufan[player_idx]
            if sf_type == "五反" and card.rank == '5':
                return True
            if sf_type == "三反" and card.rank == '3':
                return True
        
        return False
    
    def get_card_level(self, card: Card) -> int:
        """获取牌的等级（越小越大）"""
        # 方片5最大
        if card.suit == Suit.DIAMOND and card.rank == '5':
            return 0
        
        # 大王
        if card.rank == '大王':
            return 3
        
        # 小王
        if card.rank == '小王':
            return 4
        
        # 黑桃Q
        if card.suit == Suit.SPADE and card.rank == 'Q':
            return 5
        
        # 主花色J
        if self.trump_suit and card.suit == self.trump_suit and card.rank == 'J':
            return 6
        
        # 其他J
        if card.rank == 'J':
            return 7
        
        # 主花色2
        if self.trump_suit and card.suit == self.trump_suit and card.rank == '2':
            return 8
        
        # 其他2
        if card.rank == '2':
            return 9
        
        # 副牌
        return 10 + RANK_ORDER.index(card.rank)
    
    def compare_cards(self, card1: Card, card2: Card, lead_suit: Optional[Suit] = None) -> int:
        """比较两张牌大小，返回1表示card1大，-1表示card2大，0相等"""
        # 检查是否是主牌
        t1 = self.is_trump(card1)
        t2 = self.is_trump(card2)
        
        if t1 and not t2:
            return 1
        if t2 and not t1:
            return -1
        
        if t1 and t2:
            # 都是主牌，比较等级
            l1 = self.get_card_level(card1)
            l2 = self.get_card_level(card2)
            if l1 < l2:
                return 1
            elif l1 > l2:
                return -1
            return 0
        
        # 都是副牌
        if lead_suit:
            # 有首家出牌花色
            follow1 = card1.suit == lead_suit
            follow2 = card2.suit == lead_suit
            
            if follow1 and not follow2:
                return 1
            if follow2 and not follow1:
                return -1
        
        # 同花色或都无主，比较点数
        try:
            idx1 = RANK_ORDER.index(card1.rank)
            idx2 = RANK_ORDER.index(card2.rank)
            if idx1 > idx2:
                return 1
            elif idx1 < idx2:
                return -1
        except ValueError:
            pass
        
        return 0
    
    def check_true_gang(self, cards: List[Card]) -> bool:
        """检查是否是真杠（四张相同）"""
        if len(cards) != 4:
            return False
        ranks = [c.rank for c in cards if c.suit != Suit.JOKER]
        return len(set(ranks)) == 1 and len(ranks) == 4
    
    def check_false_gang(self, cards: List[Card]) -> bool:
        """检查是否是假杠（黑桃 Q + 三张相同）"""
        if len(cards) != 4:
            return False
        
        # 必须有黑桃 Q
        spade_q = [c for c in cards if c.suit == Suit.SPADE and c.rank == 'Q']
        if not spade_q:
            return False
        
        # 其他三张必须点数相同
        others = [c for c in cards if not (c.suit == Suit.SPADE and c.rank == 'Q')]
        if len(others) != 3:
            return False
        
        other_ranks = [c.rank for c in others]
        return len(set(other_ranks)) == 1 and len(other_ranks) == 3
    
    def get_gang_rank(self, cards: List[Card]) -> str:
        """获取杠的点数（用于比较大小）"""
        if self.check_true_gang(cards):
            return cards[0].rank
        elif self.check_false_gang(cards):
            # 假杠返回三张相同的点数
            others = [c for c in cards if not (c.suit == Suit.SPADE and c.rank == 'Q')]
            return others[0].rank
        return None
    
    def can_throw_cards(self, hand: List[Card], cards: List[Card], suit: Suit) -> bool:
        """检查是否可以甩牌（同花色且都是最大的）"""
        # 必须是同花色
        if not all(c.suit == suit for c in cards):
            return False
        
        same_suit_cards = [c for c in hand if c.suit == suit and not self.is_trump(c)]
        
        # 检查甩出的牌是否都是该花色中最大的
        for throw_card in cards:
            for hand_card in same_suit_cards:
                if hand_card not in cards:  # 手牌中还有没甩出的同花色牌
                    # 如果手牌中有比甩出的牌大的，则不能甩
                    if self.compare_cards(hand_card, throw_card, None) > 0:
                        return False
        
        return True
    
    def _card_sort_key(self, card: Card) -> tuple:
        """排序键：先主牌后副牌，主牌按等级从大到小，副牌按花色和点数"""
        # 大小王
        if card.suit == Suit.JOKER:
            return (0, 0, 0 if card.rank == '大王' else 1)
        
        # 方片 5（最大主牌）
        if card.suit == Suit.DIAMOND and card.rank == '5':
            return (0, 1, 0)
        
        # 黑桃 Q（固定主牌）
        if card.suit == Suit.SPADE and card.rank == 'Q':
            return (0, 2, 0)
        
        # 主花色 J
        if self.trump_suit and card.suit == self.trump_suit and card.rank == 'J':
            return (0, 3, 0)
        
        # 其他 J
        if card.rank == 'J':
            return (0, 4, 0)
        
        # 主花色 2
        if self.trump_suit and card.suit == self.trump_suit and card.rank == '2':
            return (0, 5, 0)
        
        # 其他 2
        if card.rank == '2':
            return (0, 6, 0)
        
        # 主花色其他牌（按点数从大到小）
        if self.trump_suit and card.suit == self.trump_suit:
            rank_idx = RANK_ORDER.index(card.rank) if card.rank in RANK_ORDER else 99
            return (0, 7, -rank_idx)  # 负数表示从大到小
        
        # 副牌：先按花色，再按点数
        suit_order = {Suit.SPADE: 0, Suit.HEART: 1, Suit.CLUB: 2, Suit.DIAMOND: 3}
        rank_idx = RANK_ORDER.index(card.rank) if card.rank in RANK_ORDER else 99
        return (1, suit_order.get(card.suit, 9), rank_idx)
    
    def calculate_score(self, cards: List[Card]) -> int:
        """计算分牌得分"""
        score = 0
        for card in cards:
            if card.rank == '5':
                score += 5
            elif card.rank in ['10', 'K']:
                score += 10
        return score
