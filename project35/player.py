"""
玩家操作相关
"""

from typing import List, Tuple
from itertools import combinations
from project35.card import Card, Suit
from project35.rules import Rules


class Player:
    """玩家"""
    
    def __init__(self, name: str, team: int):
        self.name = name
        self.team = team
        self.hand: List[Card] = []
        self.score = 0
    
    def sort_hand(self, rules: Rules):
        """对手牌进行排序（先主牌后副牌）"""
        self.hand.sort(key=lambda c: rules._card_sort_key(c))
    
    def show_hand(self, rules: Rules):
        """显示手牌（横排展示，先主牌后副牌）"""
        print(f"\n{self.name} 的手牌:")
        self.sort_hand(rules)
        cards_str = " ".join(str(card) for card in self.hand)
        print(f"  {cards_str}")
    
    def show_hand_with_index(self, rules: Rules):
        """显示手牌（带序号）"""
        print(f"\n{self.name} 当前手牌 (共{len(self.hand)}张):")
        self.sort_hand(rules)
        for idx, card in enumerate(self.hand):
            print(f"  {idx+1}.{card}", end="")
        print()
    
    def select_card(self, valid_cards: List[Card], prompt: str) -> Card:
        """选择一张牌"""
        print(f"\n{prompt}")
        print("  ", end="")
        for idx, card in enumerate(valid_cards):
            print(f"{idx+1}.{card}", end=" ")
        print()
        
        while True:
            try:
                choice = input(f"\n{self.name} 请选择 (1-{len(valid_cards)}): ")
                choice_idx = int(choice) - 1
                if 0 <= choice_idx < len(valid_cards):
                    return valid_cards[choice_idx]
                else:
                    print("无效的选择，请重新输入!")
            except ValueError:
                print("请输入有效的数字!")
    
    def select_cards(self, valid_cards: List[Card], num_cards: int, prompt: str) -> List[Card]:
        """选择多张牌"""
        print(f"\n{prompt} (需要选择 {num_cards} 张牌)")
        print("  ", end="")
        for idx, card in enumerate(valid_cards):
            print(f"{idx+1}.{card}", end=" ")
        print()
        
        while True:
            try:
                choice_str = input(f"\n{self.name} 请选择 {num_cards} 张牌 (用空格分隔): ")
                choices = choice_str.strip().split()
                
                if len(choices) != num_cards:
                    print(f"请选择正好 {num_cards} 张牌!")
                    continue
                
                selected = []
                valid = True
                for c in choices:
                    idx = int(c) - 1
                    if 0 <= idx < len(valid_cards) and valid_cards[idx] not in selected:
                        selected.append(valid_cards[idx])
                    else:
                        valid = False
                        break
                
                if valid and len(selected) == num_cards:
                    return selected
                else:
                    print("选择无效，请重新输入!")
            
            except ValueError:
                print("请输入有效的数字!")
    
    def get_valid_cards(self, rules: Rules, lead_suit: Suit = None, 
                       is_first: bool = False, first_is_trump: bool = False,
                       num_cards: int = 1) -> List[Card]:
        """获取有效牌（已排序）"""
        # 确保手牌已排序
        self.sort_hand(rules)
        
        if is_first:
            return self.hand[:]
        
        # 首家出主牌的情况
        if first_is_trump:
            trumps = [c for c in self.hand if rules.is_trump(c)]
            if len(trumps) >= num_cards:
                return trumps
            else:
                others = [c for c in self.hand if not rules.is_trump(c)]
                return trumps + others[:num_cards - len(trumps)]
        
        # 首家出副牌（有花色要求）
        if lead_suit:
            same_suit = [c for c in self.hand if c.suit == lead_suit and not rules.is_trump(c)]
            if same_suit:
                return same_suit
            
            trumps = [c for c in self.hand if rules.is_trump(c)]
            others = [c for c in self.hand if not rules.is_trump(c)]
            return trumps + others
        
        return self.hand[:]
    
    def get_valid_throws(self, rules: Rules, suit: Suit) -> List[List[Card]]:
        """获取某花色的所有有效甩牌组合"""
        same_suit = [c for c in self.hand if c.suit == suit and not rules.is_trump(c)]
        
        if len(same_suit) <= 1:
            return []
        
        valid_throws = []
        # 尝试 2 张、3 张、4 张的组合
        for size in range(2, min(len(same_suit) + 1, 5)):
            for combo in combinations(same_suit, size):
                if rules.can_throw_cards(self.hand, list(combo), suit):
                    valid_throws.append(list(combo))
        
        return valid_throws
    
    def has_true_gang(self) -> List[str]:
        """检查是否有真杠，返回可组成的杠的点数列表"""
        from collections import Counter
        rank_counts = Counter(c.rank for c in self.hand if c.suit != Suit.JOKER)
        return [r for r, c in rank_counts.items() if c >= 4]
    
    def has_false_gang(self) -> List[str]:
        """检查是否有假杠，返回可组成的杠的点数列表"""
        spade_q = [c for c in self.hand if c.suit == Suit.SPADE and c.rank == 'Q']
        if not spade_q:
            return []
        
        from collections import Counter
        rank_counts = Counter(c.rank for c in self.hand if c.suit != Suit.JOKER 
                             and not (c.suit == Suit.SPADE and c.rank == 'Q'))
        return [r for r, c in rank_counts.items() if c >= 3]
