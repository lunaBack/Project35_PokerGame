"""
三五反扑克游戏 - 主入口
山西阳泉地区四人扑克游戏
"""

from project35 import SanWuFanGame


def main():
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
        print(f"  {player.name} (Team {player.team}): {player.score}分")


if __name__ == "__main__":
    main()
