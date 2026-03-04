"""
游戏核心逻辑
"""

import random
from typing import List, Dict, Optional, Tuple
from collections import defaultdict

from project35.card import Card, Suit, RANK_ORDER
from project35.rules import Rules
from project35.player import Player


class SanWuFanGame:
    """三五反游戏主类"""
    
    def __init__(self):
        self.deck: List[Card] = []
        self.players: List[Player] = []
        self.rules = Rules()
        self.zhuangjia: int = 0
        self.current_player: int = 0
        self.bottom_cards: List[Card] = []
        self.lead_suit: Optional[Suit] = None
        self.current_play_type: Optional[str] = None
        self._first_is_trump: bool = False
        self._first_play_cards: List[Card] = []
        self.game_round: int = 0
        self.gong_cards: Dict[int, List[Card]] = defaultdict(list)
    
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
        
        # 每人 12 张，底牌 6 张
        self.players = []
        for i in range(4):
            hand = self.deck[i*12:(i+1)*12]
            player = Player(f"玩家{i+1}", i % 2)
            player.hand = hand
            player.sort_hand(self.rules)
            self.players.append(player)
        
        self.bottom_cards = self.deck[48:54]
        print(f"\n底牌已扣好 (共{len(self.bottom_cards)}张)")
    
    def draw_bottom_cards(self):
        """庄家摸底牌并扣牌"""
        zhuang = self.players[self.zhuangjia]
        print(f"\n=== 庄家扣底牌 ===")
        print(f"庄家 {zhuang.name} 需要扣牌")
        print(f"底牌: {' '.join(str(c) for c in self.bottom_cards)}")
        
        # 把底牌加入庄家手牌
        zhuang.hand.extend(self.bottom_cards)
        
        # 排序并显示当前手牌（带序号）
        zhuang.sort_hand(self.rules)
        zhuang.show_hand_with_index(self.rules)
        
        # 选择要扣掉的6张牌
        print(f"\n请选择 6 张牌扣掉 (不能扣分牌: 5, 10, K)")
        
        while True:
            try:
                choice_str = input(f"\n{zhuang.name} 请选择 6 张牌 (用空格分隔): ")
                choices = choice_str.strip().split()
                
                if len(choices) != 6:
                    print("请选择正好 6 张牌!")
                    continue
                
                selected = []
                valid = True
                hand = zhuang.hand
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
                    for card in selected:
                        print(card.rank)
                    print("不能扣分牌! 请重新选择!")
                    continue
                
                # 移除扣掉的牌
                for card in selected:
                    zhuang.hand.remove(card)
                
                print(f"\n扣牌完成! 扣掉的牌: {' '.join(str(c) for c in selected)}")
                print(f"庄家剩余手牌 ({len(zhuang.hand)}张):")
                zhuang.show_hand_with_index(self.rules)
                break
            
            except ValueError:
                print("请输入有效的数字!")
    
    def determine_trump(self):
        """定主亮牌"""
        print("\n=== 定主阶段 ===")
        
        # 首局：谁先亮出 2 谁成为主家
        if self.game_round == 0:
            for i, player in enumerate(self.players):
                twos = [c for c in player.hand if c.rank == '2']
                if twos:
                    self.rules.set_trump_suit(twos[0].suit)
                    self.zhuangjia = i
                    print(f"{player.name} 亮出 {twos[0]}，成为主家，主牌花色：{self.rules.trump_suit.value}")
                    return
        
        # 其他局：亮出 2 的玩家仅确定主牌花色
        for i, player in enumerate(self.players):
            twos = [c for c in player.hand if c.rank == '2']
            if twos:
                self.rules.set_trump_suit(twos[0].suit)
                print(f"{player.name} 亮出 {twos[0]}，主牌花色：{self.rules.trump_suit.value}")
                return
        
        # 断电规则
        self._handle_power_cut()
    
    def _handle_power_cut(self):
        """断电处理"""
        print("无人亮牌，触发断电规则")
        non_zhuang_team = 1 - (self.zhuangjia % 2)
        
        if self.bottom_cards:
            card = random.choice(self.bottom_cards)
            if card.suit != Suit.JOKER:
                self.rules.set_trump_suit(card.suit)
            else:
                self.rules.set_trump_suit(Suit.SPADE)
            print(f"从底牌中抽出 {card}，主牌花色：{self.rules.trump_suit.value}")
        
        print(f"Team {non_zhuang_team} 免进贡")
    
    def check_sanfan_wufan(self):
        """检查三五反"""
        print("\n=== 亮三五反阶段 ===")
        sanfan_wufan = {}
        
        for i, player in enumerate(self.players):
            threes = [c for c in player.hand if c.rank == '3' and c.suit != Suit.JOKER]
            fives = [c for c in player.hand if c.rank == '5' and c.suit != Suit.JOKER]
            
            # 排除方片 5
            fives = [c for c in fives if not (c.suit == Suit.DIAMOND and c.rank == '5')]
            
            if len(fives) >= 3:
                sanfan_wufan[i] = "五反"
                print(f"{player.name} 亮出五反！")
            elif len(threes) >= 3:
                sanfan_wufan[i] = "三反"
                print(f"{player.name} 亮出三反！")
        
        self.rules.set_sanfan_wufan(sanfan_wufan)
    
    def play_round(self) -> int:
        """进行一轮出牌"""
        print(f"\n--- 第{self.game_round+1}轮出牌 ---")
        
        current = self.current_player
        plays = []
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
                    print(f"  {self.players[p_idx].name}: {cards_str}")
            
            # 出牌
            if is_first:
                cards = self._select_first_play(player)
            else:
                cards = self._select_follow_play(player)
            
            # 移除手牌
            for card in cards:
                player.hand.remove(card)
            
            plays.append((player_idx, cards))
            cards_str = ', '.join(str(c) for c in cards)
            print(f"\n{player.name} 出：{cards_str}")
        
        # 确定赢家
        winner = self._determine_winner(plays)
        print(f"\n本轮赢家：{self.players[winner].name}")
        
        # 计算分牌
        round_score_cards = []
        for _, play_cards in plays:
            for card in play_cards:
                if card.rank in ['5', '10', 'K']:
                    round_score_cards.append(card)
        
        score = self.rules.calculate_score(round_score_cards)
        self.players[winner].score += score
        if round_score_cards:
            print(f"本轮分牌：{[str(c) for c in round_score_cards]}，得分：{score}")
        
        self.current_player = winner
        return winner
    
    def _select_first_play(self, player: Player) -> List[Card]:
        """首家选择出牌"""
        player.show_hand(self.rules)
        
        print("\n请选择出牌类型:")
        print("  1. 单张")
        print("  2. 甩牌 (多张同花色)")
        print("  3. 真杠 (四张相同)")
        print("  4. 假杠 (黑桃 Q + 三张相同)")
        
        while True:
            try:
                type_choice = input("\n请输入选项 (1-4): ")
                
                if type_choice == '1':
                    valid_cards = player.get_valid_cards(self.rules, is_first=True)
                    card = player.select_card(valid_cards, "请选择要出的牌:")
                    self.current_play_type = 'single'
                    self._first_is_trump = self.rules.is_trump(card)
                    self.lead_suit = card.suit if not self._first_is_trump else None
                    self._first_play_cards = [card]
                    return [card]
                
                elif type_choice == '2':
                    suits = set(c.suit for c in player.hand if c.suit != Suit.JOKER 
                               and not self.rules.is_trump(c))
                    print("选择甩牌花色:")
                    for idx, s in enumerate(suits):
                        print(f"  {idx+1}. {s.value}")
                    suit_idx = int(input("请选择花色：")) - 1
                    suit = list(suits)[suit_idx]
                    
                    valid_throws = player.get_valid_throws(self.rules, suit)
                    if not valid_throws:
                        print("没有可以甩的牌!")
                        continue
                    
                    print(f"\n可以甩的牌:")
                    for idx, throw in enumerate(valid_throws):
                        cards_str = ', '.join(str(c) for c in throw)
                        print(f"  {idx+1}. {cards_str}")
                    
                    choice = int(input("请选择甩哪几张：")) - 1
                    if 0 <= choice < len(valid_throws):
                        cards = valid_throws[choice]
                        self.current_play_type = 'throw'
                        self._first_is_trump = False
                        self.lead_suit = cards[0].suit
                        self._first_play_cards = cards
                        return cards
                
                elif type_choice == '3':
                    true_gangs = player.has_true_gang()
                    if not true_gangs:
                        print("没有真杠!")
                        continue
                    
                    print("\n真杠:")
                    for idx, rank in enumerate(true_gangs):
                        print(f"  {idx+1}. {rank}")
                    
                    choice = int(input("请选择哪个真杠：")) - 1
                    if 0 <= choice < len(true_gangs):
                        rank = true_gangs[choice]
                        cards = [c for c in player.hand if c.rank == rank][:4]
                        self.current_play_type = 'true_gang'
                        self._first_is_trump = True
                        self._first_play_cards = cards
                        return cards
                
                elif type_choice == '4':
                    false_gang_ranks = player.has_false_gang()
                    if not false_gang_ranks:
                        print("没有可以组成假杠的牌!")
                        continue
                    
                    print("\n假杠:")
                    for idx, rank in enumerate(false_gang_ranks):
                        print(f"  {idx+1}. Q + {rank}{rank}{rank}")
                    
                    choice = int(input("请选择哪个假杠：")) - 1
                    if 0 <= choice < len(false_gang_ranks):
                        rank = false_gang_ranks[choice]
                        q_card = [c for c in player.hand if c.suit == Suit.SPADE and c.rank == 'Q'][0]
                        other_cards = [c for c in player.hand if c.rank == rank][:3]
                        cards = [q_card] + other_cards
                        self.current_play_type = 'false_gang'
                        self._first_is_trump = True
                        self._first_play_cards = cards
                        return cards
                
                else:
                    print("无效的选项!")
            
            except ValueError:
                print("请输入有效的数字!")
    
    def _select_follow_play(self, player: Player) -> List[Card]:
        """跟牌"""
        # 先显示手牌
        player.show_hand(self.rules)
        
        num_cards = len(self._first_play_cards)
        
        if self.current_play_type in ['true_gang', 'false_gang']:
            print(f"\n当前出牌类型：{self.current_play_type}")
            print("您需要出主牌!")
        
        if self._first_is_trump:
            prompt = "首家出主牌，您必须出主牌!"
        else:
            prompt = f"首家出牌花色：{self.lead_suit.value}" if self.lead_suit else "首家出副牌"
        
        valid_cards = player.get_valid_cards(
            self.rules, self.lead_suit, False, 
            self._first_is_trump, num_cards
        )
        
        if num_cards == 1:
            return [player.select_card(valid_cards, prompt)]
        else:
            return player.select_cards(valid_cards, num_cards, prompt)
    
    def _determine_winner(self, plays: List[Tuple[int, List[Card]]]) -> int:
        """确定赢家"""
        if self.current_play_type == 'true_gang':
            return self._find_gang_winner(plays, True)
        elif self.current_play_type == 'false_gang':
            return self._find_gang_winner(plays, False)
        else:
            return self._find_normal_winner(plays)
    
    def _find_gang_winner(self, plays: List[Tuple[int, List[Card]]], is_true: bool) -> int:
        """找出杠的赢家"""
        winner = plays[0][0]
        max_rank = self.rules.get_gang_rank(plays[0][1])
        GANG_ORDER = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2']
        
        for player_idx, cards in plays[1:]:
            rank = self.rules.get_gang_rank(cards)
            if rank:
                if is_true and not self.rules.check_true_gang(cards):
                    winner = player_idx
                    max_rank = rank
                elif not is_true and self.rules.check_true_gang(cards):
                    continue
                elif GANG_ORDER.index(rank) < GANG_ORDER.index(max_rank):
                    winner = player_idx
                    max_rank = rank
        
        return winner
    
    def _find_normal_winner(self, plays: List[Tuple[int, List[Card]]]) -> int:
        """找出普通出牌的赢家"""
        winner = plays[0][0]
        max_cards = plays[0][1]
        
        for player_idx, cards in plays[1:]:
            if self._compare_card_sets(cards, max_cards) > 0:
                winner = player_idx
                max_cards = cards
        
        return winner
    
    def _compare_card_sets(self, cards1: List[Card], cards2: List[Card]) -> int:
        """比较两组牌"""
        if not cards1 or not cards2:
            return 0
        
        trump1 = [c for c in cards1 if self.rules.is_trump(c)]
        trump2 = [c for c in cards2 if self.rules.is_trump(c)]
        
        if trump1 and not trump2:
            return 1
        if trump2 and not trump1:
            return -1
        
        if trump1 and trump2:
            max_trump1 = max(trump1, key=lambda c: 100 - self.rules.get_card_level(c))
            max_trump2 = max(trump2, key=lambda c: 100 - self.rules.get_card_level(c))
            return self.rules.compare_cards(max_trump1, max_trump2, None)
        
        return self.rules.compare_cards(cards1[0], cards2[0], self.lead_suit)
    
    def settle_game(self) -> Dict:
        """结算本局"""
        print("\n=== 本局结算 ===")
        xianjia_team = 1 - (self.zhuangjia % 2)
        xianjia_score = sum(p.score for p in self.players if p.team == xianjia_team)
        
        print(f"闲家得分: {xianjia_score}")
        
        result = {
            'xianjia_score': xianjia_score,
            'zhuangjia_next': self.zhuangjia,
            'tribute': []
        }
        
        if xianjia_score == 0:
            print("闲家得0分，双进贡给庄家")
            result['tribute'] = [(i, self.zhuangjia) for i in range(4) 
                                if self.players[i].team == xianjia_team]
        elif xianjia_score >= 80:
            print("闲家得分≥80，庄家双进贡给闲家")
            result['tribute'] = [(self.zhuangjia, i) for i in range(4) 
                                if self.players[i].team == xianjia_team]
            result['zhuangjia_next'] = (self.zhuangjia + 1) % 4
        elif xianjia_score >= 60:
            print("闲家得分≥60且<80，庄家进贡上庄人")
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
            self.shuffle_and_deal()
            self.determine_trump()
            self.check_sanfan_wufan()
            self.draw_bottom_cards()
            
            print(f"\n=== 游戏信息 ===")
            print(f"庄家：{self.players[self.zhuangjia].name}")
            print(f"主牌花色：{self.rules.trump_suit.value if self.rules.trump_suit else '无'}")
            
            self.current_player = self.zhuangjia
            for round_num in range(12):
                winner = self.play_round()
                input(f"\n按回车键继续下一轮...")
            
            result = self.settle_game()
            self.zhuangjia = result['zhuangjia_next']
            
            print(f"\n本局结束，下一局庄家：玩家{self.zhuangjia+1}")
            if game < num_games - 1:
                input("\n按回车键开始下一局...")
