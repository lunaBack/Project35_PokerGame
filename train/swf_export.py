# train/swf_export.py —— 从 model.pt 导出 ONNX（训练与导出分离）
import os
import sys

import torch

sys.path.insert(0, os.path.dirname(__file__))
from swf_train import QNet, N_CHAN, CTX_DIM

base = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), 'model')
model = QNet()
model.load_state_dict(torch.load(base + '.pt', map_location='cpu', weights_only=True))
model.eval()
dummy_cards = torch.zeros(1, N_CHAN, 54)
dummy_ctx = torch.zeros(1, CTX_DIM)
dummy_cands = torch.zeros(1, 8, 54)
dummy_mask = torch.zeros(1, 8)
torch.onnx.export(model, (dummy_cards, dummy_ctx, dummy_cands, dummy_mask), base + '.onnx',
                  input_names=['cards', 'ctx', 'cands', 'cand_mask'],
                  output_names=['logits', 'win'],
                  dynamic_axes={'cands': {1: 'K'}, 'cand_mask': {1: 'K'}, 'logits': {1: 'K'}},
                  opset_version=18, dynamo=False)
print('exported', base + '.onnx')
