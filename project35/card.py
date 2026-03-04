"""
牌相关定义
"""

from enum import Enum
from dataclasses import dataclass
from typing import Tuple


class Suit(Enum):
    """花色"""
    SPADE = "♠"      # 黑桃
    HEART = "♥"      # 红桃
    CLUB = "♣"       # 梅花
    DIAMOND = "♦"    # 方片
    JOKER = "JOKER"  # 王牌


@dataclass
class Card:
    """扑克牌"""
    suit: Suit
    rank: str  # 2-10, J, Q, K, A, 小王, 大王
    
    def __str__(self):
        if self.suit == Suit.JOKER:
            return self.rank
        return f"{self.suit.value}{self.rank}"
    
    def __hash__(self):
        return hash((self.suit, self.rank))
    
    def __eq__(self, other):
        if not isinstance(other, Card):
            return False
        return self.suit == other.suit and self.rank == other.rank


# 牌值顺序（用于副牌比较）
RANK_ORDER = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2']


# 主牌等级（从大到小）
TRUMP_LEVELS = [
    "方片5",      # 最大的主牌
    "五反",       # 三个5
    "三反",       # 三个3
    "大王",
    "小王",
    "黑桃Q",      # 固定主牌
    "主花色J",
    "其他花色J",
    "主花色2",
    "其他花色2",
]
