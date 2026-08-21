/**
 * ui.js —— 界面渲染与人机交互
 * 通过 Promise 桥接游戏引擎与玩家操作（选牌、出牌、亮牌、扣底、还贡等）
 */
'use strict';

const $ = (id) => document.getElementById(id);

/** 应用设置：出牌节奏与 AI 难度，持久化到 localStorage */
const AppSettings = (() => {
    const read = (k, d) => { try { return localStorage.getItem(k) || d; } catch (e) { return d; } };
    const write = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
    return {
        speed: read('swf_speed', 'normal'),
        difficulty: read('swf_difficulty', 'normal'),
        speedMult() { return ({ fast: 0.4, normal: 1, slow: 1.8 })[this.speed] || 1; },
        setSpeed(v) { this.speed = v; write('swf_speed', v); },
        setDifficulty(v) {
            this.difficulty = ['easy', 'normal', 'hard'].includes(v) ? v : 'normal';
            write('swf_difficulty', this.difficulty);
            AI.setDifficulty(this.difficulty);
        },
    };
})();

const UI = {
    game: null,
    selectedIds: new Set(),   // 当前选中的手牌
    selecting: false,         // 是否处于选牌模式
    toastTimer: null,

    /* ==================== 日志 ==================== */
    log(msg, cls) {
        const el = document.createElement('div');
        if (cls) el.className = cls;
        el.textContent = msg;
        $('log').appendChild(el);
        $('log').scrollTop = $('log').scrollHeight;
    },

    toast(msg) {
        const t = $('toast');
        t.textContent = msg;
        t.classList.remove('hidden');
        clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
    },

    /* ==================== 卡牌 DOM ==================== */
    cardEl(card, ctx, small) {
        const el = document.createElement('div');
        el.className = 'card ' + (isRedCard(card) ? 'red' : 'black');
        if (card.suit === 'joker') {
            el.classList.add('joker-card');
            el.innerHTML = `<div class="corner">${card.rank === 'BJ' ? '大王' : '小王'}</div><div class="big">🃏</div>`;
        } else {
            el.innerHTML = `<div class="corner">${card.rank}\n${SUIT_SYMBOL[card.suit]}</div><div class="big">${SUIT_SYMBOL[card.suit]}</div>`;
        }
        if (ctx) {
            if (ctx.fan5Ids.has(card.id) || ctx.fan3Ids.has(card.id)) el.classList.add('fan-card');
            else if (isTrump(card, ctx)) el.classList.add('trump-card');
        }
        el.dataset.cid = card.id;
        return el;
    },

    /* ==================== 渲染 ==================== */
    render(game) {
        this.game = game;
        // 顶栏
        $('info-hand').textContent = game.handNo || '-';
        $('info-trump').textContent = game.trumpSuit
            ? `${SUIT_SYMBOL[game.trumpSuit]} ${SUIT_NAME[game.trumpSuit]}` : '未定';
        $('info-trump').style.color = (game.trumpSuit === 'heart' || game.trumpSuit === 'diamond') ? '#ff8a8a' : '#fff';
        $('info-dealer').textContent = game.dealer >= 0 ? game.players[game.dealer].name : '-';
        $('info-score').textContent = game.defenderPoints;
        $('info-win0').textContent = game.teamWins[0];
        $('info-win1').textContent = game.teamWins[1];
        const trickEl = $('info-trick');
        if (game.trickNo > 0 && game.curLeader >= 0) {
            let leadDesc = '';
            let leadColor = '';
            if (game.lead) {
                if (game.lead.group === 'trump') {
                    leadDesc = ' · 调主牌';
                    leadColor = '#ffd76a';
                } else {
                    const s = game.lead.group;
                    leadDesc = ` · 调${SUIT_SYMBOL[s]}${SUIT_NAME[s]}`;
                    leadColor = (s === 'heart' || s === 'diamond') ? '#ff8a8a' : '#9ad6ff';
                }
            }
            trickEl.textContent = `第 ${game.trickNo} 轮 · ${game.players[game.curLeader].name}领出${leadDesc}`;
            trickEl.style.color = leadColor;
        } else {
            trickEl.textContent = '-';
            trickEl.style.color = '';
        }

        // 庄家标记
        for (let i = 0; i < 4; i++) {
            const badge = document.querySelector(`#seat-${i} .dealer-badge`);
            badge.classList.toggle('hidden', game.dealer !== i);
        }

        // 对手手牌（牌背 + 数量）
        for (const i of [1, 2, 3]) {
            const box = $(`hand-${i}`);
            box.innerHTML = '';
            const n = game.players[i].hand.length;
            for (let k = 0; k < n; k++) box.appendChild(Object.assign(document.createElement('div'), { className: 'card-back' }));
            let tag = box.parentElement.querySelector('.count-tag');
            if (!tag) {
                tag = document.createElement('div');
                tag.className = 'count-tag';
                box.parentElement.appendChild(tag);
            }
            tag.textContent = `${n} 张`;
        }

        this.renderMyHand();
        this.renderTrick();
    },

    renderMyHand() {
        const game = this.game;
        const box = $('hand-0');
        box.innerHTML = '';
        if (!game) return;
        const hand = game.players[0].hand;
        // 清理已不在手牌中的选中项
        const ids = new Set(hand.map(c => c.id));
        for (const id of [...this.selectedIds]) if (!ids.has(id)) this.selectedIds.delete(id);

        const sorted = game.ctx ? sortHand(hand, game.ctx) : hand;
        box.classList.toggle('disabled', !this.selecting);
        for (const c of sorted) {
            const el = this.cardEl(c, game.ctx);
            if (this.selectedIds.has(c.id)) el.classList.add('selected');
            el.onclick = () => {
                if (!this.selecting) return;
                if (this.selectedIds.has(c.id)) this.selectedIds.delete(c.id);
                else this.selectedIds.add(c.id);
                el.classList.toggle('selected');
            };
            box.appendChild(el);
        }
    },

    renderTrick() {
        const game = this.game;
        for (let i = 0; i < 4; i++) $(`played-${i}`).innerHTML = '';
        if (!game || !game.trick) return;
        game.trick.forEach((t, ti) => {
            const zone = $(`played-${t.playerIdx}`);
            for (const c of t.cards) {
                const el = this.cardEl(c, game.ctx);
                if (ti === game.trick.length - 1) el.classList.add('anim-in'); // 只对最新一手牌做入场动画
                zone.appendChild(el);
            }
        });
        $('center-hint').textContent = game.trick.length === 0 && game.trumpSuit === null ? '等待开局…' : '';
    },

    clearTable() {
        for (let i = 0; i < 4; i++) {
            const z = $(`played-${i}`);
            z.innerHTML = '';
            z.classList.remove('win-glow');
        }
        if (this.game) this.game.trick = [];
    },

    markWinner(idx) {
        $(`played-${idx}`).classList.add('win-glow');
    },

    setTurnGlow(idx) {
        for (let i = 0; i < 4; i++) $(`seat-${i}`).classList.toggle('turn-glow', i === idx);
    },

    /* ==================== 通用弹窗 ==================== */
    showModal(title, bodyBuilder, actions) {
        return new Promise(resolve => {
            $('modal-title').textContent = title;
            const body = $('modal-body');
            body.innerHTML = '';
            bodyBuilder(body);
            const act = $('modal-actions');
            act.innerHTML = '';
            for (const a of actions) {
                const btn = document.createElement('button');
                btn.className = 'btn ' + (a.primary ? 'primary' : 'secondary');
                btn.textContent = a.label;
                btn.onclick = () => {
                    const v = a.value();
                    if (v === undefined) return; // 校验未通过，弹窗不关闭
                    $('modal-mask').classList.add('hidden');
                    resolve(v);
                };
                act.appendChild(btn);
            }
            $('modal-mask').classList.remove('hidden');
        });
    },

    /* ==================== 交互：定主亮牌 ==================== */
    async askRevealTrump(twos, firstHand) {
        let picked = null;
        // 花色预览：选中某张 2 时，手牌中该花色的牌全部高亮为"被选中"状态，定主结束后恢复原状
        const hint = (suit) => {
            const game = this.game;
            if (!game || !game.players || !game.players[0]) return;
            const ids = new Set(suit ? game.players[0].hand.filter(c => c.suit === suit).map(c => c.id) : []);
            document.querySelectorAll('#hand-0 .card').forEach(el => {
                el.classList.toggle('suit-hint', ids.has(Number(el.dataset.cid)));
            });
        };
        const result = await this.showModal(
            firstHand ? '抢亮定主（先亮 2 者为庄家）' : '亮牌定主（亮 2 确定主牌花色）',
            body => {
                body.innerHTML = `<p>你手中有 2，可以亮出定主${firstHand ? '并成为庄家' : ''}。选择一张 2 亮出（手牌中该花色的牌会高亮预览），或选择不亮：</p>`;
                const row = document.createElement('div');
                row.className = 'card-row';
                for (const c of twos) {
                    const el = this.cardEl(c);
                    el.onclick = () => {
                        picked = picked === c ? null : c;
                        row.querySelectorAll('.card').forEach(x => x.classList.remove('selected'));
                        if (picked) el.classList.add('selected');
                        hint(picked ? picked.suit : null);
                    };
                    row.appendChild(el);
                }
                body.appendChild(row);
            },
            [
                { label: '不亮', value: () => null },
                { label: '亮出定主', primary: true, value: () => picked === null ? (this.toast('请先选择一张 2'), undefined) : picked },
            ]
        );
        hint(null);
        return result;
    },

    /* ==================== 交互：亮三五反 ==================== */
    async askFanReveal(options) {
        const chosen = new Set();
        return this.showModal(
            '亮三五反',
            body => {
                body.innerHTML = '<p>你起到了三个同点牌，可亮为三反/五反（成为仅次于方片5的主牌，且你方免进贡）。点击选择要亮的组：</p>';
                for (const opt of options) {
                    const row = document.createElement('div');
                    row.className = 'card-row';
                    const label = document.createElement('span');
                    label.textContent = opt.rank === '5' ? '五反：' : '三反：';
                    label.style.alignSelf = 'center';
                    row.appendChild(label);
                    for (const c of opt.cards) row.appendChild(this.cardEl(c));
                    row.style.cursor = 'pointer';
                    row.onclick = () => {
                        if (chosen.has(opt)) chosen.delete(opt); else chosen.add(opt);
                        row.querySelectorAll('.card').forEach(x => x.classList.toggle('selected', chosen.has(opt)));
                    };
                    body.appendChild(row);
                }
            },
            [
                { label: '不亮', value: () => [] },
                { label: '亮出', primary: true, value: () => chosen.size === 0 ? (this.toast('请先点击选择要亮的组'), undefined) : [...chosen] },
            ]
        );
    },

    /* ==================== 交互：还贡 ==================== */
    async askReturnTribute(hand, ctx, payerName) {
        // 还贡：贡牌与分牌之外的任意主牌；无则退而还非分副牌
        let valid = hand.filter(c => isTrump(c, ctx) && !c.fromTribute && cardPoints(c) === 0);
        let note = '请选择一张主牌还贡（不能还贡牌与分牌）：';
        if (valid.length === 0) {
            valid = hand.filter(c => cardPoints(c) === 0 && !c.fromTribute);
            note = '你无可还的主牌，请选择一张非分牌还贡：';
        }
        if (valid.length === 0) valid = hand.slice();
        let picked = null;
        return this.showModal(
            `还贡给 ${payerName}`,
            body => {
                body.innerHTML = `<p>${note}</p>`;
                const row = document.createElement('div');
                row.className = 'card-row';
                for (const c of sortHand(valid, ctx)) {
                    const el = this.cardEl(c, ctx);
                    el.onclick = () => {
                        picked = picked === c ? null : c;
                        row.querySelectorAll('.card').forEach(x => x.classList.remove('selected'));
                        if (picked) el.classList.add('selected');
                    };
                    row.appendChild(el);
                }
                body.appendChild(row);
            },
            [{ label: '确定还贡', primary: true, value: () => picked === null ? (this.toast('请选择一张牌'), undefined) : picked }]
        );
    },

    /* ==================== 交互：庄家扣底 ==================== */
    askBury(hand, ctx) {
        return new Promise(resolve => {
            this.selecting = true;
            this.selectedIds.clear();
            this.renderMyHand();
            this.setTurnGlow(0);
            $('action-bar').classList.remove('hidden');
            $('action-msg').textContent = '你是庄家：请选择 6 张牌扣入底牌（底牌不能扣分）';
            $('btn-hint').onclick = () => {
                const sug = AI.chooseBury(hand, ctx);
                this.selectedIds = new Set(sug.map(c => c.id));
                this.renderMyHand();
            };
            $('btn-play').textContent = '确认扣底';
            $('btn-play').onclick = () => {
                const sel = hand.filter(c => this.selectedIds.has(c.id));
                if (sel.length !== 6) { this.toast('必须恰好选择 6 张牌'); return; }
                const nonPointCnt = hand.filter(c => cardPoints(c) === 0).length;
                if (sel.some(c => cardPoints(c) > 0) && nonPointCnt >= 6) {
                    this.toast('底牌不能扣分（5、10、K 不能扣入底牌）');
                    return;
                }
                this.endSelect();
                resolve(sel);
            };
        });
    },

    /* ==================== 交互：出牌 / 跟牌 ==================== */
    askPlay(player, game, isLead) {
        return new Promise(resolve => {
            this.selecting = true;
            this.renderMyHand();
            this.setTurnGlow(0);
            $('action-bar').classList.remove('hidden');
            const leadDesc = isLead ? '轮到你领出（可出单张 / 甩牌 / 真杠 / 假杠）'
                : `轮到你跟牌（须出 ${game.lead.count} 张）`;
            $('action-msg').textContent = leadDesc;
            $('btn-hint').onclick = () => {
                let sug;
                if (isLead) sug = AI.chooseLead(player.hand, game.ctx, game.otherHands(0));
                else sug = AI.chooseFollow(player.hand, game.trick, game.lead, game.ctx, 0, 2);
                this.selectedIds = new Set(sug.map(c => c.id));
                this.renderMyHand();
            };
            $('btn-play').textContent = '出牌';
            $('btn-play').onclick = () => {
                const sel = player.hand.filter(c => this.selectedIds.has(c.id));
                if (sel.length === 0) { this.toast('请先选择要出的牌'); return; }
                this.endSelect();
                resolve(sel);
            };
        });
    },

    endSelect() {
        this.selecting = false;
        this.selectedIds.clear();
        $('action-bar').classList.add('hidden');
        this.setTurnGlow(-1);
        this.renderMyHand();
    },

    /* ==================== 设置面板 ==================== */
    openSettings() {
        return this.showModal(
            '设置',
            body => {
                const radio = (name, opts, cur, onPick) => {
                    const row = document.createElement('div');
                    row.className = 'settings-row';
                    for (const [val, label] of opts) {
                        const lab = document.createElement('label');
                        const inp = document.createElement('input');
                        inp.type = 'radio'; inp.name = name; inp.value = val; inp.checked = (cur === val);
                        inp.onchange = () => onPick(val);
                        lab.appendChild(inp);
                        lab.appendChild(document.createTextNode(label));
                        row.appendChild(lab);
                    }
                    return row;
                };
                body.innerHTML = '';
                const s = document.createElement('p'); s.textContent = '出牌节奏（AI 与过渡动画速度）：'; body.appendChild(s);
                body.appendChild(radio('speed', [['fast', '快'], ['normal', '正常'], ['slow', '慢']], AppSettings.speed, v => AppSettings.setSpeed(v)));
                const d = document.createElement('p'); d.textContent = 'AI 难度（下一局起生效）：'; body.appendChild(d);
                body.appendChild(radio('difficulty', [['easy', '简单'], ['normal', '普通'], ['hard', '困难（推演）']], AppSettings.difficulty, v => AppSettings.setDifficulty(v)));
                const btn = document.createElement('button');
                btn.className = 'btn secondary';
                btn.style.marginTop = '8px';
                btn.textContent = '清零战绩';
                btn.onclick = () => {
                    if (this.game) this.game.resetRecord();
                    this.toast('战绩已清零');
                };
                body.appendChild(btn);
                // 联机操作：按当前角色显示关房/退房入口（对局中也能随时使用）
                if (typeof NetHost !== 'undefined' && NetHost.active) {
                    const netBtn = document.createElement('button');
                    netBtn.className = 'btn secondary';
                    netBtn.style.marginTop = '8px';
                    netBtn.textContent = '关闭房间（断开所有房员）';
                    netBtn.onclick = () => NetHost.closeRoom();
                    body.appendChild(netBtn);
                } else if (typeof NetClient !== 'undefined' && NetClient.connected) {
                    const netBtn = document.createElement('button');
                    netBtn.className = 'btn secondary';
                    netBtn.style.marginTop = '8px';
                    netBtn.textContent = '退出房间（返回主界面）';
                    netBtn.onclick = () => NetClient.leaveRoom();
                    body.appendChild(netBtn);
                }
            },
            [{ label: '关闭', primary: true, value: () => true }]
        );
    },

    /* ==================== 结算 ==================== */
    showSettlement(game, text) {
        return this.showModal(
            `第 ${game.handNo} 局结算`,
            body => {
                const detailRows = game.scoreLog.length > 0
                    ? game.scoreLog.map(s => `第 ${s.no} 轮：${s.who} 收分 +${s.pts}`).join('<br>')
                    : '闲家方本局未收到任何分牌';
                const tributeRows = game.tributePlan.length > 0
                    ? game.tributePlan.map(t => `${game.players[t.from].name} → ${game.players[t.to].name}（进贡最大主牌）`).join('<br>')
                    : '无';
                body.innerHTML = `
                    <div class="settle-score">闲家方 ${game.defenderPoints} 分</div>
                    <p style="text-align:center">${text}</p>
                    <p style="font-size:13px;color:#8ec7ff;margin-top:8px">闲家得分明细：</p>
                    <div class="settle-detail">${detailRows}</div>
                    <p style="font-size:13px;color:#8ec7ff">下局预告：庄家 ${game.players[game.nextDealer].name}，进贡安排：</p>
                    <div class="settle-detail">${tributeRows}</div>
                    <p style="text-align:center;color:#8fa8c4;font-size:12px;margin-top:8px">
                        战绩：你方 ${game.teamWins[0]} : ${game.teamWins[1]} 对方
                    </p>`;
            },
            [{ label: '下一局', primary: true, value: () => true }]
        );
    },
};

/* ==================== 启动 ==================== */
window.addEventListener('DOMContentLoaded', () => {
    // 桌面版防护：拦截一切外链锚点导航
    document.addEventListener('click', (e) => {
        const a = e.target.closest && e.target.closest('a[href]');
        if (a && /^https?:/i.test(a.href)) e.preventDefault();
    });

    $('btn-rules').onclick = () => $('rules-mask').classList.remove('hidden');
    $('btn-rules-close').onclick = () => $('rules-mask').classList.add('hidden');
    $('rules-mask').onclick = (e) => { if (e.target === $('rules-mask')) $('rules-mask').classList.add('hidden'); };
    $('btn-settings').onclick = () => UI.openSettings();

    AI.setDifficulty(AppSettings.difficulty); // 恢复上次的难度选择

    UI.showModal(
        '欢迎来到《三五反》',
        body => {
            body.innerHTML = `
                <p>山西阳泉四人扑克游戏：你与<b>对家</b>为一队，对抗左家与右家。</p>
                <p>54 张牌，每人 12 张、底牌 6 张。首局发牌后先亮 2 者为庄家并定主牌花色；
                   之后按规则进行亮三五反、庄家扣底、逐轮出牌与结算。</p>
                <p style="color:#8fa8c4">提示：出牌阶段可点击"提示"按钮获得建议；点击右上角"查看规则"可随时查阅规则要点，
                   也可点击<span class="rules-link" id="link-rules-quick">规则速览</span>。</p>
                <p style="color:#8ec7ff;font-size:13px"><b>联机方法</b>：房主点「联机 · 创建房间」，把生成的<b>邀请码</b>
                   （如 K7Q2）发给朋友（<b>跨网络也能连</b>，经公网中继转接）；朋友点「联机 · 加入房间」输入邀请码即可入座。
                   同一局域网也可用完整邀请串直连。房主掉线则本局作废；房员掉线由 AI 自动托管，重连后可加入下一局。
                   对局中可在「设置」里关闭/退出房间。<b>注意：所有人必须使用同一版本的程序。</b></p>`;
        },
        [
            { label: '简单开局', value: () => { AppSettings.setDifficulty('easy'); return true; } },
            { label: '标准开局', primary: true, value: () => { AppSettings.setDifficulty('normal'); return true; } },
            { label: '联机 · 创建房间', value: () => { NetHost.start().catch(() => UI.toast('创建房间失败（仅桌面版支持）')); return null; } },
            { label: '联机 · 加入房间', value: () => { NetClient.showJoin(); return null; } },
        ]
    ).then(startSingle => {
        $('link-rules-quick')?.remove(); // 弹窗已关闭，清理引用
        if (!startSingle) return;        // 联机入口：不启动本地单机对局
        const game = new Game(UI);
        game.playHand();
    });

    // 规则速览链接需在弹窗插入 DOM 后绑定
    const bindQuickLink = () => {
        const link = $('link-rules-quick');
        if (link) link.onclick = () => $('rules-mask').classList.remove('hidden');
    };
    setTimeout(bindQuickLink, 0);
});
