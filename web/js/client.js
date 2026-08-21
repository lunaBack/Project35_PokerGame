/**
 * client.js —— 房员端瘦客户端：连接房主、渲染快照、回传操作意图
 * 本地不跑游戏引擎；一切合法性由房主校验（非法操作会被拒绝并重问）。
 */
'use strict';

const NetClient = {
    ws: null,
    connected: false,      // 已完成 welcome 握手
    mySeat: -1,
    state: null,           // 最近一次快照
    myName: '',
    asking: false,         // 正在显示操作栏
    leaving: false,        // 主动退房中（不触发"本局结束"弹窗）

    /* ==================== 连接 ==================== */

    showJoin() {
        // 延迟一帧再弹窗：若从欢迎弹窗按钮进入，同一帧内先隐藏再显示的弹窗不会被渲染
        setTimeout(() => this._showJoinModal(), 0);
    },

    _showJoinModal() {
        const inputs = {};
        UI.showModal(
            '加入联机房间',
            body => {
                body.innerHTML = `
                    <p>请向房主索要<b>邀请码</b>（如 <code>K7Q2</code>）并输入；局域网直连也可整段粘贴邀请串：</p>
                    <p><input id="net-join-addr" type="text" placeholder="邀请码（或 CODE@IP:端口）" style="width:100%;padding:8px;border-radius:6px;border:1px solid #3d5a80;background:#0f1c2e;color:#e8f1fb"></p>
                    <p>你的昵称：</p>
                    <p><input id="net-join-name" type="text" maxlength="8" placeholder="昵称（可留空）" style="width:100%;padding:8px;border-radius:6px;border:1px solid #3d5a80;background:#0f1c2e;color:#e8f1fb"></p>`;
                inputs.addr = body.querySelector('#net-join-addr');
                inputs.name = body.querySelector('#net-join-name');
            },
            [
                { label: '取消', value: () => null },
                {
                    label: '连接', primary: true, value: () => {
                        const inv = NetProto.parseInvite(inputs.addr.value);
                        if (!inv.host && !inv.code) { UI.toast('请填写邀请码或邀请串'); return undefined; }
                        if (!inv.host && !NET_RELAY_URL) { UI.toast('本版本未配置公网中继，请使用完整邀请串（局域网）'); return undefined; }
                        const name = (inputs.name.value || '').trim() || '玩家';
                        this.connect(inv, name);
                        return null; // 关闭弹窗（连接结果用 toast/弹层反馈）
                    },
                },
            ]
        );
    },

    connect(inv, name) {
        this.myName = String(name || '').trim().replace(/[<>&"'\\]/g, '').slice(0, 8) || '玩家';
        // 纯邀请码 → 经公网中继；含地址 → 局域网直连
        const viaRelay = !inv.host;
        const url = viaRelay ? `${NET_RELAY_URL}/room/${inv.code}?role=member` : 'ws://' + inv.host;
        let ws;
        try { ws = new WebSocket(url); }
        catch (e) { UI.toast('地址格式不正确'); return; }
        this.ws = ws;
        UI.toast(viaRelay ? `正在通过中继连接房间 ${inv.code} …` : '正在连接 ' + inv.host + ' …');
        ws.onopen = () => {
            ws.send(JSON.stringify({ t: 'hello', ver: NET_VER, code: inv.code, name: this.myName }));
        };
        ws.onmessage = (e) => {
            let m; try { m = JSON.parse(e.data); } catch (err) { return; }
            if (m && m.p === 'err') { // 中继层错误（房间不存在等）
                UI.toast(m.msg === 'no such room' ? `房间 ${inv.code} 不存在：请确认房主已建房且邀请码正确` : '连接失败：' + m.msg);
                return;
            }
            this.handle(m);
        };
        ws.onclose = () => {
            if (this.leaving) return;   // 主动退房：直接刷新回主界面
            if (!this.connected) { UI.toast('连接失败：请检查邀请码/邀请串与网络'); return; }
            // 对局中断开 = 房主掉线/关房
            this.connected = false;
            this.showGameOver();
        };
        ws.onerror = () => { /* onclose 会随后触发 */ };
    },

    send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); },

    /** 主动退出房间（设置面板入口）：断开连接并回到主界面 */
    leaveRoom() {
        this.leaving = true;
        try { if (this.ws) this.ws.close(); } catch (e) {}
        window.location.reload();
    },

    /* ==================== 消息处理 ==================== */

    handle(m) {
        switch (m.t) {
            case 'welcome':
                this.connected = true;
                this.mySeat = m.seat;
                UI.toast(this.mySeat >= 0 ? `已加入房间，座位 ${this.mySeat}` : '已加入房间（观战）');
                break;
            case 'reject':
                UI.toast(m.msg || '被房间拒绝');
                this.connected = false;
                try { this.ws.close(); } catch (e) {}
                break;
            case 'lobby': this.showLobby(m); break;
            case 'state': this.state = m; this.onState(m); break;
            case 'log': UI.log(m.msg, m.cls); break;
            case 'toast': UI.toast(m.msg); break;
        }
    },

    showGameOver() {
        UI.showModal(
            '本局结束',
            body => { body.innerHTML = '<p>与房主的连接已断开（房主掉线或关闭了房间）。</p><p>当前对局作废。请联系房主重新开局，拿到新的邀请串后再加入。</p>'; },
            [{ label: '返回', primary: true, value: () => { window.location.reload(); return true; } }]
        );
    },

    /* ==================== 大厅 ==================== */

    showLobby(m) {
        const box = $('net-overlay');
        box.classList.remove('hidden');
        $('net-title').textContent = '联机房间';
        $('net-invite').textContent = '等待房主开始游戏…';
        $('net-start').classList.add('hidden');
        $('net-copy').classList.add('hidden');
        $('net-close-room').textContent = '退出房间';
        $('net-close-room').onclick = () => window.location.reload();
        const sit = $('net-sit');
        sit.classList.remove('hidden');
        sit.textContent = this.mySeat >= 0 ? `已就座（座位 ${this.mySeat}）` : '请求入座';
        sit.disabled = this.mySeat >= 0;
        sit.onclick = () => this.send({ t: 'sit' });
        $('net-wait').classList.remove('hidden');
        const el = $('net-seats');
        el.innerHTML = '';
        m.names.forEach((n, i) => {
            const row = document.createElement('div');
            row.className = 'net-seat-row';
            row.textContent = `座位 ${i}：${n}`;
            el.appendChild(row);
        });
    },

    /* ==================== 对局渲染 ==================== */

    /** 快照 → 以本座位为"下方"的展示用伪 game 对象（复用 UI.render） */
    viewGame(s) {
        const my = s.mySeat >= 0 ? s.mySeat : 0;
        const disp = i => (i - my + 4) % 4;            // 真实座位 → 显示位置
        const myTeam = my % 2;
        const ctx = makeRuleCtx(
            s.trumpSuit,
            new Set(s.fan5.map(t => NET_CARD_ID[t])),
            new Set(s.fan3.map(t => NET_CARD_ID[t]))
        );
        const players = [0, 1, 2, 3].map(d => ({
            idx: d,
            name: s.players[(my + d) % 4].name,
            isHuman: d === 0,
            hand: d === 0 ? s.myHand.map(NetProto.parse) : new Array(s.handCounts[(my + d) % 4]).fill(0),
        }));
        return {
            handNo: s.handNo,
            trumpSuit: s.trumpSuit,
            dealer: s.dealer >= 0 ? disp(s.dealer) : -1,
            defenderPoints: s.defenderPoints,
            teamWins: myTeam === 0 ? s.teamWins : [s.teamWins[1], s.teamWins[0]],
            trickNo: s.trickNo,
            curLeader: s.curLeader >= 0 ? disp(s.curLeader) : -1,
            lead: s.lead,
            trick: s.trick.map(x => ({ playerIdx: disp(x.playerIdx), cards: x.cards.map(NetProto.parse) })),
            players,
            ctx,
        };
    },

    onState(s) {
        $('net-overlay').classList.add('hidden');
        const view = this.viewGame(s);
        UI.game = view;
        UI.render(view);
        // 座位真名标注（显示位置 1/2/3 = 右家/对家/左家）
        for (let d = 1; d <= 3; d++) {
            const el = document.querySelector(`#seat-${d} .seat-name`);
            if (el) el.firstChild.textContent = view.players[d].name;
        }
        UI.setTurnGlow(s.turn >= 0 ? (s.turn - (s.mySeat >= 0 ? s.mySeat : 0) + 4) % 4 : -1);

        if (s.phase === 'settlement') { this.endAsking(); this.showSettlement(s); return; }
        if (s.ask) this.showAsk(s);
        else this.endAsking();
    },

    /* ==================== 操作（回传意图，房主校验） ==================== */

    showAsk(s) {
        const ask = s.ask;
        if (ask.kind === 'reveal') return this.askReveal(ask);
        if (ask.kind === 'fan') return this.askFan(ask);
        if (ask.kind === 'tributeBack') return this.askTributeBack(ask, s);
        this.asking = true;
        UI.selecting = true;
        UI.renderMyHand();
        UI.setTurnGlow(0);
        $('action-bar').classList.remove('hidden');
        if (ask.kind === 'bury') {
            $('action-msg').textContent = '你是庄家：请选择 6 张牌扣入底牌（底牌不能扣分）';
        } else {
            $('action-msg').textContent = ask.isLead
                ? '轮到你领出（可出单张 / 甩牌 / 真杠 / 假杠）'
                : `轮到你跟牌（须出 ${s.lead.count} 张）`;
        }
        $('btn-hint').onclick = () => {
            const view = this.viewGame(s);
            const hand = view.players[0].hand;
            let sug;
            if (ask.kind === 'bury') sug = AI.chooseBury(hand, view.ctx);
            else if (ask.isLead) sug = AI.heurLead(hand, view.ctx, [[], [], []]);
            else sug = AI.heurFollow(hand, view.trick, view.lead, view.ctx, 0, 2);
            UI.selectedIds = new Set(sug.map(c => c.id));
            UI.renderMyHand();
        };
        $('btn-play').textContent = ask.kind === 'bury' ? '确认扣底' : '出牌';
        $('btn-play').onclick = () => {
            const view = this.viewGame(s);
            const hand = view.players[0].hand;
            const sel = hand.filter(c => UI.selectedIds.has(c.id));
            if (sel.length === 0) { UI.toast('请先选择要出的牌'); return; }
            if (ask.kind === 'bury') {
                if (sel.length !== 6) { UI.toast('必须恰好选择 6 张牌'); return; }
                const nonPointCnt = hand.filter(c => cardPoints(c) === 0).length;
                if (sel.some(c => cardPoints(c) > 0) && nonPointCnt >= 6) {
                    UI.toast('底牌不能扣分（5、10、K 不能扣入底牌）');
                    return;
                }
            }
            this.send({ t: 'action', kind: ask.kind, cards: sel.map(NetProto.ser) });
            this.endAsking();
        };
    },

    endAsking() {
        if (!this.asking) return;
        this.asking = false;
        UI.selecting = false;
        UI.selectedIds.clear();
        $('action-bar').classList.add('hidden');
        UI.renderMyHand();
    },

    async askReveal(ask) {
        const view = this.viewGame(this.state);
        const twos = ask.twos.map(NetProto.parse);
        const chosen = await UI.askRevealTrump(twos, ask.firstHand);
        this.send({ t: 'action', kind: 'reveal', chosen: chosen ? NetProto.ser(chosen) : null });
    },

    async askFan(ask) {
        const options = ask.options.map(o => ({ rank: o.rank, cards: o.cards.map(NetProto.parse) }));
        const picks = await UI.askFanReveal(options);
        this.send({
            t: 'action', kind: 'fan',
            picks: picks.map(o => ({ rank: o.rank, cards: o.cards.map(NetProto.ser) })),
        });
    },

    async askTributeBack(ask, s) {
        const view = this.viewGame(s);
        const hand = view.players[0].hand;
        const back = await UI.askReturnTribute(hand, view.ctx, ask.payerName);
        this.send({ t: 'action', kind: 'tributeBack', chosen: NetProto.ser(back) });
    },

    /* ==================== 结算（只读） ==================== */

    showSettlement(s) {
        const st = s.settlement;
        const my = s.mySeat >= 0 ? s.mySeat : 0;
        const disp = i => (i - my + 4) % 4;
        UI.showModal(
            `第 ${s.handNo} 局结算`,
            body => {
                const detailRows = st.scoreLog.length > 0
                    ? st.scoreLog.map(x => `第 ${x.no} 轮：${x.who} 收分 +${x.pts}`).join('<br>')
                    : '闲家方本局未收到任何分牌';
                const tributeRows = st.tributePlan.length > 0
                    ? st.tributePlan.map(t => `${s.players[t.from].name} → ${s.players[t.to].name}（进贡最大主牌）`).join('<br>')
                    : '无';
                body.innerHTML = `
                    <div class="settle-score">闲家方 ${s.defenderPoints} 分</div>
                    <p style="text-align:center">${st.text}</p>
                    <p style="font-size:13px;color:#8ec7ff;margin-top:8px">闲家得分明细：</p>
                    <div class="settle-detail">${detailRows}</div>
                    <p style="font-size:13px;color:#8ec7ff">下局预告：庄家 ${s.players[st.nextDealer].name}，进贡安排：</p>
                    <div class="settle-detail">${tributeRows}</div>
                    <p style="text-align:center;color:#8fa8c4;font-size:12px;margin-top:8px">等待房主开始下一局…</p>`;
            },
            [{ label: '知道了', primary: true, value: () => true }]
        );
    },
};
