"""
三五反游戏实现
山西阳泉地区四人扑克游戏
命令行交互版本 - 支持 4 人本地轮流操作
"""

import random
from enum import Enum, auto
from dataclasses import dataclass, field
from typing import List, Dict, Tuple, Optional, Set
from collections import defaultdict


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


class SanWuFanGame:
    """三五反游戏主类"""
    
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
    
    def __init__(self):
        self.deck: List[Card] = []
        self.players: List[Dict] = []  # 4 个玩家
        self.trump_suit: Optional[Suit] = None  # 主牌花色
        self.zhuangjia: int = 0  # 庄家索引
        self.current_player: int = 0
        self.round_scores: List[Card] = []  # 当前轮的分牌
        self.played_cards: Set[Card] = set()  # 已出的牌
        self.sanfan_wufan: Dict[int, str] = {}  # 玩家索引 -> "三反"/"五反"
        self.game_round: int = 0  # 当前是第几局
        self.bottom_cards: List[Card] = []  # 底牌
        self.lead_suit: Optional[Suit] = None  # 首家出牌花色
        self.current_play_type: Optional[str] = None  # 当前出牌类型
        self.gong_cards: Dict[int, List[Card]] = defaultdict(list)  # 进贡获得的牌
        
    def create_deck(self) -> List[Card]:
        """创建54张牌"""
        deck = []
        ranks = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2']
        
        for suit in [Suit.SPADE, Suit.HEART, Suit.CLUB, Suit.DIAMOND]:
            for rank in ranks:
                deck.append(Card(suit, rank))
        
        # 添加大小王
        deck.append(Card(Suit.JOKER, "小王"))
        deck.append(Card(Suit.JOKER, "大王"))
        
        return deck
    
    def shuffle_and_deal(self):
        """洗牌并发牌"""
        self.deck = self.create_deck()
        random.shuffle(self.deck)
        
        # 每人12张，底牌6张
        self.players = []
        for i in range(4):
            hand = self.deck[i*12:(i+1)*12]
            self.players.append({
                'hand': sorted(hand, key=self._card_sort_key),
                'score': 0,
                'team': i % 2,  # 0和2一队，1和3一队
                'name': f"玩家{i+1}"
            })
        
        self.bottom_cards = self.deck[48:54]
        print(f"\n底牌已扣好 (共{len(self.bottom_cards)}张)")
    
    def draw_bottom_cards(self):
        """庄家摸底牌并扣牌"""
        zhuang = self.players[self.zhuangjia]
        print(f"\n=== 庄家扣底牌 ===")
        print(f"庄家 {zhuang['name']} 需要扣牌")
        print(f"底牌: {' '.join(str(c) for c in self.bottom_cards)}")
        
        # 把底牌加入庄家手牌
        zhuang['hand'].extend(self.bottom_cards)
        
        # 显示当前手牌（带序号）
        print(f"\n{zhuang['name']} 当前手牌 (共{len(zhuang['hand'])}张):")
        hand = zhuang['hand']
        for idx, card in enumerate(hand):
            print(f"  {idx+1}.{card}", end="")
        print()
        
        # 选择要扣掉的6张牌
        print(f"\n请选择 6 张牌扣掉 (不能扣分牌: 5, 10, K)")
        
        while True:
            try:
                choice_str = input(f"\n{zhuang['name']} 请选择 6 张牌 (用空格分隔): ")
                choices = choice_str.strip().split()
                
                if len(choices) != 6:
                    print("请选择正好 6 张牌!")
                    continue
                
                selected = []
                valid = True
                hand = zhuang['hand']
                for c in choices:
                    idx = int(c) - 1
                    if 0 <= idx < len(hand) and hand[idx] not in selected:
                        selected.append(hand[idx])
                    else:
                        valid = False
                        break
                
                if not valid or len(selected) != 6:
                    print("选择无效，请重新输入!")
                    continue
                
                # 检查是否有分牌
                has_score = any(c.rank in ['5', '10', 'K'] for c in selected)
                if has_score:
                    print("不能扣分牌! 请重新选择!")
                    continue
                
                # 移除扣掉的牌
                for card in selected:
                    zhuang['hand'].remove(card)
                
                print(f"\n扣牌完成! 扣掉的牌: {' '.join(str(c) for c in selected)}")
                print(f"庄家剩余手牌 ({len(zhuang['hand'])}张):")
                hand = zhuang['hand']
                for idx, card in enumerate(hand):
                    print(f"  {idx+1}.{card}", end="")
                print()
                break
            
            except ValueError:
                print("请输入有效的数字!")
        
    def show_hand(self, player_idx: int):
        """显示指定玩家的手牌（横排展示）"""
        player = self.players[player_idx]
        print(f"\n{player['name']} 的手牌:")
        cards_str = " ".join(str(card) for card in player['hand'])
        print(f"  {cards_str}")
    
    def _card_sort_key(self, card: Card) -> Tuple:
        """排序键"""
        if card.suit == Suit.JOKER:
            return (0, 0, card.rank)
        suit_order = {Suit.SPADE: 0, Suit.HEART: 1, Suit.CLUB: 2, Suit.DIAMOND: 3}
        rank_idx = RANK_ORDER.index(card.rank) if card.rank in RANK_ORDER else 99
        return (1, suit_order.get(card.suit, 9), rank_idx)
    
    def determine_trump(self):
        """定主亮牌"""
        print("\n=== 定主阶段 ===")
        
        # 首局：谁先亮出2谁成为主家
        if self.game_round == 0:
            for i, player in enumerate(self.players):
                twos = [c for c in player['hand'] if c.rank == '2']
                if twos:
                    # 找到第一个亮2的玩家
                    self.trump_suit = twos[0].suit
                    self.zhuangjia = i
                    print(f"{player['name']} 亮出 {twos[0]}，成为主家，主牌花色: {self.trump_suit.value}")
                    return
        
        # 其他局：亮出2的玩家仅确定主牌花色
        for i, player in enumerate(self.players):
            twos = [c for c in player['hand'] if c.rank == '2']
            if twos:
                self.trump_suit = twos[0].suit
                print(f"{player['name']} 亮出 {twos[0]}，主牌花色: {self.trump_suit.value}")
                return
        
        # 断电规则：无人亮牌
        self._handle_power_cut()
    
    def _handle_power_cut(self):
        """断电处理"""
        print("无人亮牌，触发断电规则")
        # 由不做庄的一方从底牌中随机抽一张花色作为主牌花色
        non_zhuang_team = 1 - (self.zhuangjia % 2)
        # 简化为随机抽取
        if self.bottom_cards:
            card = random.choice(self.bottom_cards)
            if card.suit != Suit.JOKER:
                self.trump_suit = card.suit
            else:
                self.trump_suit = Suit.SPADE  # 默认黑桃
            print(f"从底牌中抽出 {card}，主牌花色: {self.trump_suit.value}")
        
        # 断电后不做庄的一方可以免掉向庄家进贡的处罚
        print(f"Team {non_zhuang_team} 免进贡")
    
    def check_sanfan_wufan(self):
        """检查三五反"""
        print("\n=== 亮三五反阶段 ===")
        
        for i, player in enumerate(self.players):
            threes = [c for c in player['hand'] if c.rank == '3' and c.suit != Suit.JOKER]
            fives = [c for c in player['hand'] if c.rank == '5' and c.suit != Suit.JOKER]
            
            # 排除方片5（已经是最大主牌）
            fives = [c for c in fives if not (c.suit == Suit.DIAMOND and c.rank == '5')]
            
            if len(fives) >= 3:
                self.sanfan_wufan[i] = "五反"
                print(f"{player['name']} 亮出五反！")
            elif len(threes) >= 3:
                self.sanfan_wufan[i] = "三反"
                print(f"{player['name']} 亮出三反！")
    
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
    
    def is_trump_card(self, card: Card) -> bool:
        """判断是否是主牌（不考虑三反五反，用于通用判断）"""
        if card.suit == Suit.JOKER:
            return True
        if card.rank == 'Q' and card.suit == Suit.SPADE:
            return True
        if card.suit == Suit.DIAMOND and card.rank == '5':
            return True
        if self.trump_suit and card.suit == self.trump_suit:
            return True
        return False
    
    def get_card_level(self, card: Card) -> int:
        """获取牌的等级（越小越大）"""
        # 方片5最大
        if card.suit == Suit.DIAMOND and card.rank == '5':
            return 0
        
        # 三五反（特殊处理，在亮牌时确定）
        
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
    
    def has_suit(self, player_idx: int, suit: Suit) -> bool:
        """检查玩家是否有某花色的牌"""
        for card in self.players[player_idx]['hand']:
            if card.suit == suit and not self.is_trump(card):
                return True
        return False
    
    def has_trump(self, player_idx: int) -> bool:
        """检查玩家是否有主牌"""
        return any(self.is_trump(c) for c in self.players[player_idx]['hand'])
    
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
    
    def can_throw_cards(self, player_idx: int, cards: List[Card], suit: Suit) -> bool:
        """检查是否可以甩牌（同花色且都是最大的）"""
        # 必须是同花色
        if not all(c.suit == suit for c in cards):
            return False
        
        hand = self.players[player_idx]['hand']
        same_suit_cards = [c for c in hand if c.suit == suit and not self.is_trump(c)]
        
        # 检查甩出的牌是否都是该花色中最大的
        for throw_card in cards:
            for hand_card in same_suit_cards:
                if hand_card not in cards:  # 手牌中还有没甩出的同花色牌
                    # 如果手牌中有比甩出的牌大的，则不能甩
                    if self.compare_cards(hand_card, throw_card, None) > 0:
                        return False
        
        return True
    
    def get_valid_throws(self, player_idx: int, suit: Suit) -> List[List[Card]]:
        """获取某花色的所有有效甩牌组合"""
        hand = self.players[player_idx]['hand']
        same_suit = [c for c in hand if c.suit == suit and not self.is_trump(c)]
        
        if len(same_suit) <= 1:
            return []
        
        valid_throws = []
        # 尝试 2 张、3 张、4 张的组合
        from itertools import combinations
        for size in range(2, min(len(same_suit) + 1, 5)):
            for combo in combinations(same_suit, size):
                if self.can_throw_cards(player_idx, list(combo), suit):
                    valid_throws.append(list(combo))
        
        return valid_throws
    
    def _human_select_cards(self, player_idx: int, valid_cards: List[Card], 
                           num_cards: int, prompt: str) -> List[Card]:
        """人类玩家选择多张牌"""
        player = self.players[player_idx]
        
        print(f"\n{prompt} (需要选择 {num_cards} 张牌)")
        print("  ", end="")
        for idx, card in enumerate(valid_cards):
            print(f"{idx+1}.{card}", end=" ")
        print()
        
        while True:
            try:
                choice_str = input(f"\n{player['name']} 请选择 {num_cards} 张牌 (用空格分隔): ")
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
    
    def _human_select_card(self, player_idx: int, valid_cards: List[Card], prompt: str) -> Card:
        """人类玩家选择一张牌"""
        player = self.players[player_idx]
        
        # 显示有效牌（横排）
        print(f"\n{prompt}")
        print("  ", end="")
        for idx, card in enumerate(valid_cards):
            print(f"{idx+1}.{card}", end=" ")
        print()
        
        while True:
            try:
                choice = input(f"\n{player['name']} 请选择 (1-{len(valid_cards)}): ")
                choice_idx = int(choice) - 1
                if 0 <= choice_idx < len(valid_cards):
                    return valid_cards[choice_idx]
                else:
                    print("无效的选择，请重新输入!")
            except ValueError:
                print("请输入有效的数字!")
    
    def _human_select_play(self, player_idx: int, is_first: bool = False) -> List[Card]:
        """人类玩家选择出牌（可以是单张、甩牌、杠）"""
        self.show_hand(player_idx)
        hand = self.players[player_idx]['hand']
        
        if not is_first:
            # 跟牌
            # 获取首家的出牌数量
            num_cards = 1
            if hasattr(self, '_first_play_cards') and self._first_play_cards:
                num_cards = len(self._first_play_cards)
            
            valid_cards = self.get_valid_cards_for_player(player_idx, is_first)
            
            # 如果只需要一张牌
            if num_cards == 1:
                return [self._human_select_card(player_idx, valid_cards, "请选择要出的牌:")]
            else:
                # 需要选择多张牌
                prompt = "请选择要出的牌:"
                if self._first_is_trump:
                    prompt = "首家出主牌，请选择要出的牌:"
                elif self.lead_suit:
                    prompt = f"首家出 {self.lead_suit.value} 花色，请选择要出的牌:"
                
                return self._human_select_cards(player_idx, valid_cards, num_cards, prompt)
        
        # 首家可以选择出牌类型
        print("\n请选择出牌类型:")
        print("  1. 单张")
        print("  2. 甩牌 (多张同花色)")
        print("  3. 真杠 (四张相同)")
        print("  4. 假杠 (黑桃 Q + 三张相同)")
        
        while True:
            try:
                type_choice = input("\n请输入选项 (1-4): ")
                
                if type_choice == '1':
                    # 单张
                    valid_cards = hand[:]
                    return [self._human_select_card(player_idx, valid_cards, "请选择要出的牌:")]
                
                elif type_choice == '2':
                    # 甩牌
                    if self.lead_suit:
                        print(f"必须出{self.lead_suit.value}花色")
                        suit = self.lead_suit
                    else:
                        print("选择甩牌花色:")
                        suits = set(c.suit for c in hand if c.suit != Suit.JOKER and not self.is_trump(c))
                        for idx, s in enumerate(suits):
                            print(f"  {idx+1}. {s.value}")
                        suit_idx = int(input("请选择花色：")) - 1
                        suit = list(suits)[suit_idx]
                    
                    valid_throws = self.get_valid_throws(player_idx, suit)
                    if not valid_throws:
                        print("没有可以甩的牌!")
                        continue
                    
                    print(f"\n可以甩的牌:")
                    for idx, throw in enumerate(valid_throws):
                        cards_str = ', '.join(str(c) for c in throw)
                        print(f"  {idx+1}. {cards_str}")
                    
                    choice = int(input("请选择甩哪几张：")) - 1
                    if 0 <= choice < len(valid_throws):
                        return valid_throws[choice]
                    else:
                        print("无效的选择!")
                
                elif type_choice == '3':
                    # 真杠
                    from collections import Counter
                    rank_counts = Counter(c.rank for c in hand if c.suit != Suit.JOKER)
                    true_gangs = [r for r, c in rank_counts.items() if c >= 4]
                    
                    if not true_gangs:
                        print("没有真杠!")
                        continue
                    
                    print("\n真杠:")
                    for idx, rank in enumerate(true_gangs):
                        print(f"  {idx+1}. {rank}")
                    
                    choice = int(input("请选择哪个真杠：")) - 1
                    if 0 <= choice < len(true_gangs):
                        rank = true_gangs[choice]
                        gang_cards = [c for c in hand if c.rank == rank][:4]
                        return gang_cards
                    else:
                        print("无效的选择!")
                
                elif type_choice == '4':
                    # 假杠
                    spade_q = [c for c in hand if c.suit == Suit.SPADE and c.rank == 'Q']
                    if not spade_q:
                        print("没有黑桃 Q，无法组成假杠!")
                        continue
                    
                    from collections import Counter
                    rank_counts = Counter(c.rank for c in hand if c.suit != Suit.JOKER 
                                         and not (c.suit == Suit.SPADE and c.rank == 'Q'))
                    false_gang_ranks = [r for r, c in rank_counts.items() if c >= 3]
                    
                    if not false_gang_ranks:
                        print("没有可以组成假杠的牌!")
                        continue
                    
                    print("\n假杠:")
                    for idx, rank in enumerate(false_gang_ranks):
                        print(f"  {idx+1}. Q + {rank}{rank}{rank}")
                    
                    choice = int(input("请选择哪个假杠：")) - 1
                    if 0 <= choice < len(false_gang_ranks):
                        rank = false_gang_ranks[choice]
                        q_card = spade_q[0]
                        other_cards = [c for c in hand if c.rank == rank][:3]
                        return [q_card] + other_cards
                    else:
                        print("无效的选择!")
                
                else:
                    print("无效的选项!")
            
            except ValueError:
                print("请输入有效的数字!")
    
    def get_valid_cards_for_player(self, player_idx: int, is_first: bool = False) -> List[Card]:
        """获取玩家当前可以出的所有有效牌"""
        hand = self.players[player_idx]['hand']
        
        if is_first:
            # 首家可以出任意牌
            return hand[:]
        
        # 获取首家的出牌数量
        num_cards = 1
        if hasattr(self, '_first_play_cards') and self._first_play_cards:
            num_cards = len(self._first_play_cards)
        
        # 首家出主牌的情况
        if hasattr(self, '_first_is_trump') and self._first_is_trump:
            # 必须出主牌，数量不足用副牌充量
            trumps = [c for c in hand if self.is_trump(c, player_idx)]
            if len(trumps) >= num_cards:
                return trumps
            else:
                # 主牌不足，用副牌充量
                others = [c for c in hand if not self.is_trump(c, player_idx)]
                return trumps + others[:num_cards - len(trumps)]
        
        # 首家出副牌（有花色要求）
        if self.lead_suit:
            # 有同花色的牌
            same_suit = [c for c in hand if c.suit == self.lead_suit and not self.is_trump(c, player_idx)]
            if same_suit:
                return same_suit
            
            # 没有同花色，可以毙牌（用主牌）或垫牌
            trumps = [c for c in hand if self.is_trump(c, player_idx)]
            others = [c for c in hand if not self.is_trump(c, player_idx)]
            
            return trumps + others
        
        return hand[:]
    
    def play_round(self) -> int:
        """进行一轮出牌，返回赢家索引"""
        print(f"\n--- 第{self.game_round+1}轮出牌 ---")
        
        current = self.current_player
        plays = []  # (玩家索引，[牌])
        self.lead_suit = None
        self.current_play_type = None
        
        for i in range(4):
            player_idx = (current + i) % 4
            player = self.players[player_idx]
            
            is_first = (i == 0)
            
            # 显示当前局面
            if plays:
                print("\n当前已出牌:")
                for p_idx, p_cards in plays:
                    cards_str = ', '.join(str(c) for c in p_cards)
                    print(f"  {self.players[p_idx]['name']}: {cards_str}")
            
            # 人类玩家操作
            if is_first:
                # 首家出牌（可以是单张、甩牌、杠）
                cards = self._human_select_play(player_idx, is_first=True)
                
                # 确定出牌类型
                if len(cards) == 1:
                    self.current_play_type = 'single'
                    self._first_is_trump = self.is_trump(cards[0])
                    if self._first_is_trump:
                        # 首家出主牌
                        self.lead_suit = None
                    else:
                        # 首家出副牌
                        self.lead_suit = cards[0].suit
                elif self.check_true_gang(cards):
                    self.current_play_type = 'true_gang'
                    self._first_is_trump = True
                    self.lead_suit = None
                elif self.check_false_gang(cards):
                    self.current_play_type = 'false_gang'
                    self._first_is_trump = True
                    self.lead_suit = None
                else:
                    self.current_play_type = 'throw'
                    self._first_is_trump = False
                    self.lead_suit = cards[0].suit
                
                # 记录首家的牌
                self._first_play_cards = cards
            else:
                # 跟牌
                if self.current_play_type in ['true_gang', 'false_gang']:
                    # 杠的情况，需要特殊处理
                    print(f"\n当前出牌类型：{self.current_play_type}")
                    print("您需要出主牌!")
                
                # 首家出主牌时，必须出主牌
                if self._first_is_trump:
                    prompt = "首家出主牌，您必须出主牌!"
                else:
                    prompt = f"首家出牌花色：{self.lead_suit.value}" if self.lead_suit else "首家出副牌"
                    prompt += f" | 出牌类型：{self.current_play_type}" if self.current_play_type else ""
                
                cards = self._human_select_play(player_idx, is_first=False)
            
            # 移除手牌
            for card in cards:
                player['hand'].remove(card)
            
            plays.append((player_idx, cards))
            cards_str = ', '.join(str(c) for c in cards)
            print(f"\n{player['name']} 出：{cards_str}")
        
        # 确定赢家
        winner = self._determine_round_winner(plays, self.lead_suit, self.current_play_type)
        print(f"\n本轮赢家：{self.players[winner]['name']}")
        
        # 计算分牌
        round_score_cards = []
        for _, play_cards in plays:
            for card in play_cards:
                if card.rank in ['5', '10', 'K']:
                    round_score_cards.append(card)
        
        # 给赢家加分
        score = self._calculate_score(round_score_cards)
        self.players[winner]['score'] += score
        if round_score_cards:
            print(f"本轮分牌：{[str(c) for c in round_score_cards]}，得分：{score}")
        
        self.current_player = winner
        return winner
    
    def _determine_round_winner(self, plays: List[Tuple[int, List[Card]]], 
                                 lead_suit: Optional[Suit], 
                                 play_type: str) -> int:
        """确定一轮的赢家"""
        
        if play_type == 'true_gang':
            # 真杠比较：A 最大，2 最小
            return self._find_gang_winner(plays, is_true=True)
        elif play_type == 'false_gang':
            # 假杠比较
            return self._find_gang_winner(plays, is_true=False)
        else:
            # 普通出牌或甩牌，比较最大的牌
            return self._find_normal_winner(plays, lead_suit)
    
    def _find_gang_winner(self, plays: List[Tuple[int, List[Card]]], is_true: bool) -> int:
        """找出杠的赢家"""
        winner = plays[0][0]
        max_rank = self.get_gang_rank(plays[0][1])
        
        GANG_ORDER = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2']
        
        for player_idx, cards in plays[1:]:
            rank = self.get_gang_rank(cards)
            if rank:
                # 真杠可以大过假杠
                if is_true and not self.check_true_gang(cards):
                    winner = player_idx
                    max_rank = rank
                elif not is_true and self.check_true_gang(cards):
                    continue  # 真杠已经最大
                elif GANG_ORDER.index(rank) < GANG_ORDER.index(max_rank):
                    winner = player_idx
                    max_rank = rank
        
        return winner
    
    def _find_normal_winner(self, plays: List[Tuple[int, List[Card]]], 
                           lead_suit: Optional[Suit]) -> int:
        """找出普通出牌的赢家"""
        winner = plays[0][0]
        max_cards = plays[0][1]
        
        for player_idx, cards in plays[1:]:
            # 简化：只比较最大的单张
            # TODO: 需要完善甩牌和毙牌的比较逻辑
            if self._compare_card_sets(cards, max_cards, lead_suit) > 0:
                winner = player_idx
                max_cards = cards
        
        return winner
    
    def _compare_card_sets(self, cards1: List[Card], cards2: List[Card], 
                          lead_suit: Optional[Suit]) -> int:
        """比较两组牌的大小（用于甩牌等情况）"""
        # 简化处理：比较最大的牌
        if not cards1 or not cards2:
            return 0
        
        # 检查是否有主牌毙牌
        trump1 = [c for c in cards1 if self.is_trump(c)]
        trump2 = [c for c in cards2 if self.is_trump(c)]
        
        if trump1 and not trump2:
            return 1
        if trump2 and not trump1:
            return -1
        
        if trump1 and trump2:
            # 都有主牌，比较最大的主牌
            max_trump1 = max(trump1, key=lambda c: 100 - self.get_card_level(c))
            max_trump2 = max(trump2, key=lambda c: 100 - self.get_card_level(c))
            return self.compare_cards(max_trump1, max_trump2, None)
        
        # 都没有主牌，比较首张牌
        return self.compare_cards(cards1[0], cards2[0], lead_suit)
    
    def _ai_select_first(self, player_idx: int) -> List[Card]:
        """AI选择首家出牌"""
        hand = self.players[player_idx]['hand']
        
        # 优先出副牌中的大牌
        non_trumps = [c for c in hand if not self.is_trump(c)]
        if non_trumps:
            # 按点数排序，出最大的
            non_trumps.sort(key=lambda c: RANK_ORDER.index(c.rank) if c.rank in RANK_ORDER else 0)
            return [non_trumps[-1]]
        
        # 否则出最小的主牌
        trumps = [c for c in hand if self.is_trump(c)]
        trumps.sort(key=self.get_card_level, reverse=True)
        return [trumps[-1]] if trumps else [hand[0]]
    
    def _ai_select_follow(self, player_idx: int, lead_suit: Optional[Suit], 
                         plays: List[Tuple[int, List[Card]]]) -> List[Card]:
        """AI选择跟牌"""
        valid = self.get_valid_plays(player_idx, lead_suit)
        
        # 找出当前最大牌
        current_max = None
        max_player = None
        for p_idx, play in plays:
            if current_max is None:
                current_max = play[0]
                max_player = p_idx
            else:
                if self.compare_cards(play[0], current_max, lead_suit) > 0:
                    current_max = play[0]
                    max_player = p_idx
        
        # 简单策略：如果有同花色，出最小的；否则出最小的主牌或垫最小的牌
        if valid:
            # 按等级排序
            valid.sort(key=lambda c: self.get_card_level(c[0]) if self.is_trump(c[0]) 
                      else RANK_ORDER.index(c[0].rank) if c[0].rank in RANK_ORDER else 0)
            return [valid[-1][0]]  # 出最大的能出的牌尝试赢
        
        return [[self.players[player_idx]['hand'][0]]]
    
    def _determine_winner(self, plays: List[Tuple[int, List[Card]]], 
                         lead_suit: Optional[Suit]) -> int:
        """确定赢家"""
        winner = plays[0][0]
        max_card = plays[0][1][0]
        
        for player_idx, play in plays[1:]:
            card = play[0]
            if self.compare_cards(card, max_card, lead_suit) > 0:
                max_card = card
                winner = player_idx
        
        return winner
    
    def _calculate_score(self, cards: List[Card]) -> int:
        """计算分牌得分"""
        score = 0
        for card in cards:
            if card.rank == '5':
                score += 5
            elif card.rank in ['10', 'K']:
                score += 10
        return score
    
    def settle_game(self) -> Dict:
        """结算本局"""
        print("\n=== 本局结算 ===")
        
        # 闲家是庄家的对手
        xianjia_team = 1 - (self.zhuangjia % 2)
        
        # 计算闲家得分
        xianjia_score = sum(self.players[i]['score'] for i in range(4) 
                           if self.players[i]['team'] == xianjia_team)
        
        print(f"闲家得分: {xianjia_score}")
        
        result = {
            'xianjia_score': xianjia_score,
            'zhuangjia_next': self.zhuangjia,
            'tribute': []  # 进贡关系
        }
        
        if xianjia_score == 0:
            print("闲家得0分，双进贡给庄家")
            result['tribute'] = [(i, self.zhuangjia) for i in range(4) 
                                if self.players[i]['team'] == xianjia_team]
        elif xianjia_score >= 80:
            print("闲家得分≥80，庄家双进贡给闲家")
            result['tribute'] = [(self.zhuangjia, i) for i in range(4) 
                                if self.players[i]['team'] == xianjia_team]
            # 庄家下台
            result['zhuangjia_next'] = (self.zhuangjia + 1) % 4
        elif xianjia_score >= 60:
            print("闲家得分≥60且<80，庄家进贡上庄人")
            # 上庄人是庄家的下家
            shangzhuang = (self.zhuangjia + 1) % 4
            result['tribute'] = [(self.zhuangjia, shangzhuang)]
        elif xianjia_score >= 40:
            print("闲家得分≥40，庄家下台")
            result['zhuangjia_next'] = (self.zhuangjia + 1) % 4
        
        return result
    
    def play_game(self, num_games: int = 1):
        """进行多局游戏"""
        for game in range(num_games):
            print(f"\n{'='*40}")
            print(f"第 {game+1} 局游戏")
            print(f"{'='*40}")
                
            self.game_round = game
            self.sanfan_wufan = {}
                
            # 发牌
            self.shuffle_and_deal()
                
            # 定主
            self.determine_trump()
                
            # 亮三五反
            self.check_sanfan_wufan()
                        
            # 庄家扣底牌
            self.draw_bottom_cards()
                        
            # 显示主牌信息
            print(f"\n=== 游戏信息 ===")
            print(f"庄家：{self.players[self.zhuangjia]['name']}")
            print(f"主牌花色：{self.trump_suit.value if self.trump_suit else '无'}")
            if self.sanfan_wufan:
                print("三五反:")
                for idx, sf_wf in self.sanfan_wufan.items():
                    print(f"  {self.players[idx]['name']}: {sf_wf}")
                
            # 出牌阶段（12 轮，每人 12 张牌）
            self.current_player = self.zhuangjia
            for round_num in range(12):
                winner = self.play_round()
                input(f"\n按回车键继续下一轮...")
                
            # 结算
            result = self.settle_game()
            self.zhuangjia = result['zhuangjia_next']
                
            print(f"\n本局结束，下一局庄家：玩家{self.zhuangjia+1}")
            if game < num_games - 1:
                input("\n按回车键开始下一局...")


# 运行游戏
if __name__ == "__main__":
    print("=" * 60)
    print("欢迎来到三五反扑克游戏!")
    print("山西阳泉地区四人扑克游戏")
    print("=" * 60)
    
    game = SanWuFanGame()
    
    # 询问玩家数量
    while True:
        try:
            num_games = input("\n请输入要进行的局数 (默认 1): ")
            if not num_games.strip():
                num_games = 1
            else:
                num_games = int(num_games)
                if num_games < 1:
                    num_games = 1
            break
        except ValueError:
            print("请输入有效的数字!")
    
    game.play_game(num_games=num_games)
    
    print("\n" + "=" * 60)
    print("游戏结束!")
    print("=" * 60)
    
    # 显示最终得分
    print("\n最终得分:")
    for i, player in enumerate(game.players):
        print(f"  {player['name']} (Team {player['team']}): {player['score']}分")