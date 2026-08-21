// test/onnx_scorer.js —— 方案 B 模型的 Node 侧打分器（替代 MC rollout）
// 用法：await scorer.init('train/model.onnx', AI); MC.scorer = scorer.score;
const SUITS = ['spade', 'heart', 'club', 'diamond'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const CARD_IDX = {};
{
    let i = 0;
    for (const s of SUITS) for (const r of RANKS) { CARD_IDX[s + r] = i++; }
    CARD_IDX.BJ = 52; CARD_IDX.SJ = 53;
}
const LEAD_TYPES = ['none', 'single', 'throw', 'trueGang', 'fakeGang'];
const LEAD_GROUPS = ['none', 'trump', 'gang', ...SUITS];
const CTX_DIM = 22, N_CHAN = 5;

// 牌对象 -> {idx, pts}
function cardInfo(c) {
    if (c.suit === 'joker') return { idx: c.rank === 'BJ' ? 52 : 53, pts: 0 };
    const pts = c.rank === '5' ? 5 : (c.rank === '10' || c.rank === 'K' ? 10 : 0);
    return { idx: CARD_IDX[c.suit + c.rank], pts };
}

function onehot(v, table) {
    const vec = new Array(table.length).fill(0);
    vec[table.indexOf(v)] = 1;
    return vec;
}

// 与 record.js 快照同构的状态编码：state[5,54] + ctx[22]（不含动作通道，动作单独进 cands）
function encodeState(game, myIdx, isLead, lead) {
    const cards = Array.from({ length: N_CHAN }, () => new Float32Array(54));
    for (const c of game.players[myIdx].hand) cards[0][cardInfo(c).idx] = 1;
    for (const c of game.playedCards) cards[1][cardInfo(c).idx] = 1;
    let trickPts = 0;
    for (const play of game.trick) {
        for (const c of play.cards) {
            const p = cardInfo(c);
            cards[2][p.idx] = 1;
            trickPts += p.pts;
        }
    }
    // fan 牌对象藏在底牌 bottom / 手牌 / 已出牌中（与 record.js cardById 同构）
    const cardById = new Map();
    for (const p of game.players) for (const c of p.hand) cardById.set(c.id, c);
    for (const c of game.playedCards) cardById.set(c.id, c);
    for (const c of game.bottom || []) cardById.set(c.id, c);
    const fanOf = ids => [...ids].map(id => cardById.get(id)).filter(Boolean);
    for (const c of fanOf(game.ctx.fan5Ids).concat(fanOf(game.ctx.fan3Ids))) cards[4][cardInfo(c).idx] = 1;

    const ctx = [];
    ctx.push(...onehot(game.ctx.trumpSuit, SUITS));
    ctx.push(...onehot(lead ? lead.type : 'none', LEAD_TYPES));
    ctx.push(...onehot(lead ? lead.group : 'none', LEAD_GROUPS));
    ctx.push(lead ? lead.count / 12 : 0);
    ctx.push(isLead ? 1 : 0);
    ctx.push(game.players[myIdx].team !== game.ctx.dealerTeam ? 1 : 0);
    ctx.push(game.players[myIdx].hand.length / 12);
    ctx.push((game.playedCards.length + game.trick.reduce((n, t) => n + t.cards.length, 0)) / 54);
    ctx.push(trickPts / 40);
    return { cards, ctx };
}

let session = null;
let ort = null;
let heurFn = null;

async function init(modelPath, heur) {
    ort = require('onnxruntime-node');
    heurFn = heur || null;
    session = await ort.InferenceSession.create(modelPath);
    return score;
}

// MC.scorer 接口：(game, myIdx, cands, curTrick, curLead) -> 最优候选
async function score(game, myIdx, cands, curTrick, curLead) {
    if (!session || !cands || !cands.length) return null;
    const isLead = !curLead;
    // 调试：强制返回启发式候选（验证评测管线本身）
    if (process.env.SWF_HEUR === '1' && heurFn) {
        const partner = (myIdx + 2) % 4;
        const h = isLead
            ? heurFn.heurLead(game.players[myIdx].hand, game.ctx, game.otherHands(myIdx))
            : heurFn.heurFollow(game.players[myIdx].hand, game.trick, curLead, game.ctx, myIdx, partner);
        const key = cs => cs.map(c => c.id).sort((a, b) => a - b).join(',');
        const hit = cands.find(c => key(c) === key(h));
        if (hit) return hit;
    }
    const n = cands.length;
    const st = encodeState(game, myIdx, isLead, curLead);
    const cardsData = new Float32Array(N_CHAN * 54);
    for (let ch = 0; ch < N_CHAN; ch++) {
        if (ch === 3) continue; // 动作通道留空，动作经 cands 输入
        cardsData.set(st.cards[ch], ch * 54);
    }
    const candsData = new Float32Array(n * 54);
    const maskData = new Float32Array(n).fill(1);
    cands.forEach((cs, i) => { for (const c of cs) candsData[i * 54 + cardInfo(c).idx] = 1; });
    const feeds = {
        cards: new ort.Tensor('float32', cardsData, [1, N_CHAN, 54]),
        ctx: new ort.Tensor('float32', Float32Array.from(st.ctx), [1, CTX_DIM]),
        cands: new ort.Tensor('float32', candsData, [1, n, 54]),
        'cand_mask': new ort.Tensor('float32', maskData, [1, n]),
    };
    const out = await session.run(feeds);
    const logits = out.logits.data;
    let best = 0;
    const flip = process.env.SWF_FLIP === '1' ? -1 : 1;
    for (let i = 1; i < n; i++) if (flip * logits[i] > flip * logits[best]) best = i;
    return cands[best];
}

module.exports = { init, score };
