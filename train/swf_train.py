# train/swf_train.py —— 方案 B：蒸馏蒙特卡洛推演 AI（策略头 + 价值头）
# 用法：python train/swf_train.py [data=data/games_hard.jsonl] [epochs=150] [out=train/model]
# 输入：record.js 产出的 JSONL（含候选列表 cand 与终局结果 result）
# 输出：model.pt / model.onnx
#   策略头 policy(s, a)：对候选动作打分，推理时取 argmax（模仿教师 MC 的选择）
#   价值头 win(s, a)：预测本队胜率（辅助信号）
import copy
import json
import random
import sys
import os

import torch
import torch.nn as nn

SUITS = ['spade', 'heart', 'club', 'diamond']
RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
CARD_IDX = {}
_i = 0
for _s in SUITS:
    for _r in RANKS:
        CARD_IDX[f'{_s}{_r}'] = _i
        _i += 1
CARD_IDX['BJ'] = 52
CARD_IDX['SJ'] = 53

LEAD_TYPES = ['none', 'single', 'throw', 'trueGang', 'fakeGang']
LEAD_GROUPS = ['none', 'trump', 'gang'] + SUITS


def parse_card(tok):
    """'spadeQ' / 'heart10*' / 'BJ' -> (idx, points)"""
    if tok.endswith('*'):
        tok = tok[:-1]
    idx = CARD_IDX[tok]
    if tok in ('BJ', 'SJ'):
        return idx, 0
    rank = tok[len(next(s for s in SUITS if tok.startswith(s))):]
    pts = 5 if rank == '5' else (10 if rank in ('10', 'K') else 0)
    return idx, pts


def card_set_vec(toks):
    vec = [0.0] * 54
    for tok in toks:
        vec[parse_card(tok)[0]] = 1
    return vec


def onehot(v, table):
    vec = [0.0] * len(table)
    vec[table.index(v)] = 1.0
    return vec


def encode(o):
    """样本 -> (cards[5,54], ctx[22], cands[[54]], vals, label, z_win)
    注：cards[3]（动作通道）保持全零，动作只经 cands 输入，避免泄露答案"""
    cards = [[0.0] * 54 for _ in range(5)]  # 0 hand 1 visible 2 trick 3 保留空 4 fan
    for tok in o['hand']:
        cards[0][parse_card(tok)[0]] = 1
    for tok in o['visible']:
        cards[1][parse_card(tok)[0]] = 1
    trick_pts = 0
    for play in o['trick']:
        for tok in play['cards']:
            idx, pts = parse_card(tok)
            cards[2][idx] = 1
            trick_pts += pts
    chosen_vec = card_set_vec(o['chosen'])
    for tok in o['fan5'] + o['fan3']:
        cards[4][parse_card(tok)[0]] = 1

    lead = o['lead']
    i_am_def = 1.0 if o['team'] != o['dealerTeam'] else 0.0
    ctx = []
    ctx += onehot(o['trump'], SUITS)                                   # 4
    ctx += onehot(lead['type'] if lead else 'none', LEAD_TYPES)        # 5
    ctx += onehot(lead['group'] if lead else 'none', LEAD_GROUPS)      # 7
    ctx.append((lead['count'] if lead else 0) / 12.0)                  # 1
    ctx.append(1.0 if o['isLead'] else 0.0)                            # 1
    ctx.append(i_am_def)                                               # 1
    ctx.append(len(o['hand']) / 12.0)                                  # 1
    ctx.append(len(o['visible']) / 54.0)                               # 1
    ctx.append(trick_pts / 40.0)                                       # 1
    # 共 22 维

    chosen_key = sorted(parse_card(t)[0] for t in o['chosen'])
    cands, label = [], -1
    for cs in (o.get('cand') or []):
        cands.append(card_set_vec(cs))
        if label < 0 and sorted(parse_card(t)[0] for t in cs) == chosen_key:
            label = len(cands) - 1
    if not cands:  # 单候选/未捕获：候选即所选动作
        cands = [chosen_vec]
        label = 0
    vals = o.get('candVals') if o.get('candVals') and len(o['candVals']) == len(cands) else None

    z_win = 1.0 if o['result']['winTeam'] == o['team'] else 0.0
    return cards, ctx, cands, vals, label, z_win


CTX_DIM = 22
N_CHAN = 5


class QNet(nn.Module):
    """牌集合 sum-embedding + 上下文 -> 状态向量；候选过策略头打分"""

    def __init__(self, d=32, h1=256, h2=128):
        super().__init__()
        self.card_emb = nn.Embedding(54, d)
        self.state_net = nn.Sequential(
            nn.Linear(N_CHAN * d + CTX_DIM, h1), nn.ReLU(), nn.Dropout(0.1),
            nn.Linear(h1, h2), nn.ReLU(), nn.Dropout(0.1),
        )
        self.cand_net = nn.Sequential(nn.Linear(d, h2), nn.ReLU())
        self.policy_head = nn.Sequential(
            nn.Linear(h2 * 2, h2), nn.ReLU(), nn.Linear(h2, 1),
        )
        self.win_head = nn.Sequential(nn.Linear(h2 + d, h2), nn.ReLU(), nn.Linear(h2, 1))

    def forward(self, cards, ctx, cands, cand_mask):
        # cards (B,5,54)；ctx (B,CTX_DIM)；cands (B,K,54)；cand_mask (B,K) 1=有效
        emb = [cards[:, ch].float() @ self.card_emb.weight for ch in range(N_CHAN)]
        h = self.state_net(torch.cat(emb + [ctx.float()], dim=1))          # (B,h2)
        cand_emb = cands.float() @ self.card_emb.weight                    # (B,K,d)
        cand_h = self.cand_net(cand_emb)                                   # (B,K,h2)
        logits = self.policy_head(
            torch.cat([h.unsqueeze(1).expand(-1, cands.size(1), -1), cand_h], dim=2)
        ).squeeze(2)                                                       # (B,K)
        logits = logits.masked_fill(cand_mask == 0, -1e9)
        cand_act = (cand_emb * cand_mask.unsqueeze(2)).sum(1) / cand_mask.sum(1, keepdim=True).clamp(min=1)
        win = torch.sigmoid(self.win_head(torch.cat([h, cand_act], dim=1)))  # (B,1)
        return logits, win


def main():
    data_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'data', 'games_hard.jsonl')
    epochs = int(sys.argv[2]) if len(sys.argv) > 2 else 150
    out_base = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(__file__), 'model')

    samples = []
    with open(data_path, encoding='utf8') as fp:
        for line in fp:
            line = line.strip()
            if line:
                samples.append(encode(json.loads(line)))
    random.seed(7)
    random.shuffle(samples)
    n_val = max(1, len(samples) // 10)
    val, train = samples[:n_val], samples[n_val:]
    print(f'样本：训练 {len(train)} / 验证 {len(val)}')

    def batch(items, device):
        cards = torch.tensor([s[0] for s in items], device=device)
        ctx = torch.tensor([s[1] for s in items], device=device)
        k = max(len(s[2]) for s in items)
        cands = torch.zeros(len(items), k, 54, device=device)
        mask = torch.zeros(len(items), k, device=device)
        vals = torch.zeros(len(items), k, device=device)
        vmask = torch.zeros(len(items), k, device=device)
        labels = torch.zeros(len(items), dtype=torch.long, device=device)
        for i, s in enumerate(items):
            for j, cv in enumerate(s[2]):
                cands[i, j] = torch.tensor(cv)
                mask[i, j] = 1
                if s[3] is not None:
                    vals[i, j] = s[3][j]
                    vmask[i, j] = 1
            labels[i] = s[4]
        zw = torch.tensor([[s[5]] for s in items], device=device)
        return cards, ctx, cands, mask, vals, vmask, labels, zw

    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    print('device:', device, torch.cuda.get_device_name(0) if device.type == 'cuda' else '')
    model = QNet().to(device)
    opt = torch.optim.Adam(model.parameters(), lr=3e-4, weight_decay=1e-3)
    bce = nn.BCELoss()
    ce = nn.CrossEntropyLoss()

    def val_metrics():
        model.eval()
        with torch.no_grad():
            cards, ctx, cands, mask, vals, vmask, labels, zw = batch(val, device)
            logits, win = model(cards, ctx, cands, mask)
            acc = (logits.argmax(dim=1) == labels).float().mean().item()
            # 排序质量：在教师估值上，模型 argmax 与教师 argmax 的一致率
            vm = vmask.sum().item()
            if vm > 0:
                teacher_best = (vals - (1 - mask) * 1e9).argmax(dim=1)
                rank_acc = ((logits.argmax(dim=1) == teacher_best) * (vmask.sum(1) > 1)).float().sum().item() / max(1, (vmask.sum(1) > 1).sum().item())
                q = torch.sigmoid(logits)
                vmse = (((q - vals) ** 2) * vmask).sum().item() / vm
            else:
                rank_acc, vmse = 0.0, 0.0
        model.train()
        return acc, rank_acc, vmse

    best_state, best_acc = None, -1
    B = 256
    for ep in range(epochs):
        model.train()
        random.shuffle(train)
        tot = 0.0
        for i in range(0, len(train), B):
            cards, ctx, cands, mask, vals, vmask, labels, zw = batch(train[i:i + B], device)
            logits, win = model(cards, ctx, cands, mask)
            q = torch.sigmoid(logits)
            vm = vmask.sum().clamp(min=1)
            loss_v = (((q - vals) ** 2) * vmask).sum() / vm          # 密集估值回归（主损失：学排序）
            loss = loss_v + 0.3 * ce(logits, labels) + 0.2 * bce(win, zw)
            opt.zero_grad()
            loss.backward()
            opt.step()
            tot += loss.item()
        acc, rank_acc, vmse = val_metrics()
        if acc + rank_acc > best_acc:
            best_acc, best_state = acc + rank_acc, copy.deepcopy(model.state_dict())
        if (ep + 1) % 20 == 0 or ep == epochs - 1:
            print(f'epoch {ep + 1:3d}  train_loss {tot / max(1, len(train) // B):.4f}  val_top1 {acc:.3f}  val_rank {rank_acc:.3f}  val_vmse {vmse:.4f}')

    model.load_state_dict(best_state)
    torch.save(model.state_dict(), out_base + '.pt')
    print('已保存', out_base + '.pt，请用 swf_export.py 导出 ONNX')


if __name__ == '__main__':
    main()
