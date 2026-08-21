/**
 * host.js —— 房主端联机：内嵌服务器 + 房间管理 + 网络 UI 驱动
 * 架构：Rust 侧仅传输层（net_listen/net_send/...）；房间、协议、游戏逻辑全部在此。
 * 游戏引擎（Game）只在房主端运行（权威端，防作弊）；
 * 房员是瘦客户端，只收个性化快照、回传操作意图。
 */
'use strict';

const NetHost = {
    active: false,          // 房间已创建（正在监听）
    phase: 'lobby',         // lobby | playing | settlement
    port: 0,
    ip: '',
    code: '',
    conns: new Map(),       // connId -> { seat, name }
    game: null,
    pending: null,          // { seat, kind, ask, resolve } 正在等待的远程动作
    lastWaitSeat: -1,       // 最近一次等待的座位（转发校验提示用）
    transport: null,        // 可注入（测试用 mock）

    /* ==================== 传输层 ==================== */

    defaultTransport() {
        const T = window.__TAURI__;
        return {
            listen: (port) => T.core.invoke('net_listen', { port }),
            send: (id, text) => T.core.invoke('net_send', { id, text }),
            disconnect: (id) => T.core.invoke('net_disconnect', { id }),
            stop: () => T.core.invoke('net_stop'),
            localIp: () => T.core.invoke('net_local_ip'),
            onEvent: (cb) => { T.event.listen('net:event', (e) => cb(e.payload)); },
        };
    },

    /**
     * 中继传输层：房主只开一条 WebSocket 到公网中继（Worker），
     * 房员的连接在 Worker 侧落地，以信封 {p,id,d} 多路复用进这条连接。
     * 对上暴露与 Rust 直连传输完全相同的接口，房间逻辑零改动。
     */
    relayTransport(relayUrl, code) {
        let ws = null, cb = () => {}, stopping = false;
        const members = new Set();
        return {
            listen: () => new Promise((resolve, reject) => {
                try { ws = new WebSocket(`${relayUrl}/room/${code}?role=host`); }
                catch (e) { reject(new Error('中继连接失败')); return; }
                ws.onopen = () => resolve(0);
                ws.onerror = () => reject(new Error('无法连接公网中继，请检查网络'));
                ws.onmessage = (e) => {
                    let m; try { m = JSON.parse(e.data); } catch (err) { return; }
                    if (m.p === 'open') { members.add(m.id); cb({ kind: 'open', id: m.id }); }
                    else if (m.p === 'msg') cb({ kind: 'msg', id: m.id, data: m.d });
                    else if (m.p === 'close') { members.delete(m.id); cb({ kind: 'close', id: m.id }); }
                    else if (m.p === 'err') reject(new Error(m.msg === 'room busy' ? '邀请码冲突，请关闭房间后重试' : '中继错误'));
                };
                ws.onclose = () => {
                    for (const id of members) cb({ kind: 'close', id });
                    members.clear();
                    if (!stopping) cb({ kind: 'relay-lost' }); // 非主动关房时中继断开
                };
            }),
            send: (id, text) => Promise.resolve(ws && ws.readyState === 1
                ? ws.send(JSON.stringify({ p: 'msg', id, d: text })) : undefined),
            disconnect: (id) => { members.delete(id); },  // 踢人：仅停发快照；socket 归 Worker 管
            stop: () => { stopping = true; try { if (ws) ws.close(); } catch (e) {} },
            localIp: () => Promise.resolve(''),
            onEvent: (fn) => { cb = fn; },
        };
    },

    async start() {
        if (this.active) return;
        this.code = NetProto.makeCode(4);
        this.mode = NET_RELAY_URL ? 'relay' : 'direct';
        this.transport = this.transport
            || (this.mode === 'relay' ? this.relayTransport(NET_RELAY_URL, this.code) : this.defaultTransport());
        this.transport.onEvent((ev) => this.onEvent(ev));
        this.port = await this.transport.listen(NET_PORT);
        this.ip = await this.transport.localIp();
        this.active = true;
        this.phase = 'lobby';
        HostUI.showLobby(this.inviteString());
    },

    inviteString() { return this.mode === 'relay' ? this.code : `${this.code}@${this.ip}:${this.port}`; },

    /* ==================== 网络事件 ==================== */

    onEvent(ev) {
        if (ev.kind === 'msg') this.handleRaw(ev.id, ev.data);
        else if (ev.kind === 'close') this.handleClose(ev.id);
        else if (ev.kind === 'relay-lost') {
            // 与公网中继断开：房间已不可达，提示后回主界面
            UI.toast('与中继服务器的连接中断，房间已关闭');
            setTimeout(() => window.location.reload(), 2000);
        }
        // open：不做处理，等待 hello 握手
    },

    handleRaw(id, data) {
        let m;
        try { m = JSON.parse(data); } catch (e) { return; }
        if (m && m.t === 'hello') return this.handleHello(id, m);
        const conn = this.conns.get(id);
        if (!conn || !m) return;
        if (m.t === 'action') this.handleAction(conn, m);
        else if (m.t === 'sit') this.handleSit(conn);
    },

    handleHello(id, m) {
        // 版本握手：协议版本不一致直接拒绝（避免新旧 exe 混用导致通信故障）
        if (m.ver !== NET_VER) {
            this.send(id, { t: 'reject', msg: '版本不一致：请确保所有人使用同一版本的程序' });
            this.transport.disconnect(id);
            return;
        }
        if (m.code !== this.code) {
            this.send(id, { t: 'reject', msg: '邀请码不正确' });
            this.transport.disconnect(id);
            return;
        }
        if (this.conns.has(id)) return;
        // 昵称过滤特殊字符（会进入其他客户端的结算文本/日志）
        const name = String(m.name || '').trim().replace(/[<>&"'\\]/g, '').slice(0, 8) || '玩家';
        const conn = { seat: -1, name };
        this.conns.set(id, conn);
        this.tryAssignSeat(conn);
        this.send(id, { t: 'welcome', seat: conn.seat });
        UI.log(`${name} 进入了房间${conn.seat >= 0 ? `（座位 ${conn.seat}）` : '（观战）'}。`);
        this.broadcastLobby();
    },

    tryAssignSeat(conn) {
        for (const i of [1, 2, 3]) {
            let free = true;
            for (const c of this.conns.values()) if (c !== conn && c.seat === i) { free = false; break; }
            if (free) { conn.seat = i; return; }
        }
        conn.seat = -1; // 座位满：观战
    },

    handleSit(conn) {
        if (this.phase === 'playing') {
            this.sendToConn(conn, { t: 'toast', msg: '对局进行中，下一局为你安排座位' });
            return;
        }
        if (conn.seat >= 0) return;
        this.tryAssignSeat(conn);
        if (conn.seat < 0) this.sendToConn(conn, { t: 'toast', msg: '座位已满，本局请观战' });
        this.broadcastLobby();
    },

    handleAction(conn, m) {
        if (!this.pending) return;
        if (conn.seat !== this.pending.seat) {
            this.sendToConn(conn, { t: 'toast', msg: '现在不是你的回合' });
            return;
        }
        const p = this.pending;
        this.pending = null;
        p.resolve(m);
    },

    /** 房员掉线：座位本局由 AI 托管；若正在等他出牌，立即用 AI 顶上 */
    handleClose(id) {
        const conn = this.conns.get(id);
        if (!conn) return;
        this.conns.delete(id);
        const seat = conn.seat;
        if (seat < 0) return;
        if (this.game && this.phase !== 'lobby') {
            const p = this.game.players[seat];
            p.remote = false;               // 本局剩余决策走 AI 分支
            if (this.pending && this.pending.seat === seat) {
                const pd = this.pending;
                this.pending = null;
                pd.resolve(null);           // NetHostUI 返回 AI 托管动作
            }
            this.game.log(`${conn.name} 掉线，本局由 AI 托管该座位。`, 'important');
        }
        UI.log(`${conn.name} 离开了房间。`);
        if (this.phase === 'lobby') this.broadcastLobby();
    },

    /* ==================== 发送 ==================== */

    send(id, obj) { this.transport.send(id, JSON.stringify(obj)).catch(() => {}); },
    sendToConn(conn, obj) {
        for (const [id, c] of this.conns) if (c === conn) return this.send(id, obj);
    },
    sendToSeat(seat, obj) {
        for (const [id, c] of this.conns) if (c.seat === seat) return this.send(id, obj);
    },
    broadcast(obj) { for (const [id] of this.conns) this.send(id, obj); },
    broadcastLog(msg, cls) { this.broadcast({ t: 'log', msg, cls: cls || '' }); },

    /* ==================== 大厅与开局 ==================== */

    broadcastLobby() {
        if (this.phase !== 'lobby') return;
        const names = ['房主（你）', '', '', ''];
        for (const c of this.conns.values()) if (c.seat >= 1) names[c.seat] = c.name;
        for (let i = 1; i < 4; i++) if (!names[i]) names[i] = '（空位 · AI 补位）';
        this.broadcast({ t: 'lobby', names, code: this.code });
        HostUI.updateLobby(names);
    },

    startGame() {
        if (!this.active || this.game) return;
        const g = new Game(NetHostUI);
        // 每局重发手牌后重新挂载联机座位（resetHandState 会重建 players）
        const orig = g.resetHandState.bind(g);
        g.resetHandState = () => { orig(); this.applySeating(g); };
        this.applySeating(g);
        this.game = g;
        this.phase = 'playing';
        HostUI.hideLobby();
        this.broadcastLobbyStart();
        g.playHand();
    },

    broadcastLobbyStart() {
        for (const c of this.conns.values()) {
            this.sendToConn(c, {
                t: 'toast',
                msg: c.seat >= 0 ? '对局开始！' : '对局开始，你本局观战，下局可加入',
            });
        }
    },

    applySeating(g) {
        for (const c of this.conns.values()) {
            if (c.seat >= 1) {
                const p = g.players[c.seat];
                p.remote = true;
                p.isHuman = false;
                p.name = c.name;
            }
        }
    },

    /* ==================== 快照与等待动作 ==================== */

    fanTokens() {
        const g = this.game;
        const byId = new Map();
        for (const p of g.players) for (const c of p.hand) byId.set(c.id, c);
        for (const c of g.bottom) byId.set(c.id, c);
        for (const c of g.playedCards) byId.set(c.id, c);
        const toks = (ids) => [...ids].map((id) => { const c = byId.get(id); return c ? NetProto.ser(c) : null; }).filter(Boolean);
        return { fan5: toks(g.fan5Ids), fan3: toks(g.fan3Ids) };
    },

    snapshot(conn, settleText) {
        const g = this.game;
        const fan = this.fanTokens();
        const snap = {
            t: 'state',
            phase: this.phase,
            handNo: g.handNo,
            trumpSuit: g.trumpSuit,
            dealer: g.dealer,
            defenderPoints: g.defenderPoints,
            teamWins: g.teamWins,
            trickNo: g.trickNo,
            curLeader: g.curLeader,
            lead: g.lead,
            trick: g.trick.map((x) => ({ playerIdx: x.playerIdx, cards: x.cards.map(NetProto.ser) })),
            handCounts: g.players.map((p) => p.hand.length),
            players: g.players.map((p) => ({ name: p.name })),
            fan5: fan.fan5,
            fan3: fan.fan3,
            mySeat: conn.seat,
            myHand: conn.seat >= 0 ? g.players[conn.seat].hand.map(NetProto.ser) : [],
            turn: this.pending ? this.pending.seat : -1,
            ask: null,
        };
        if (this.pending && this.pending.seat === conn.seat) snap.ask = this.pending.ask;
        if (this.phase === 'settlement') {
            snap.settlement = {
                text: settleText || '',
                scoreLog: g.scoreLog,
                tributePlan: g.tributePlan,
                nextDealer: g.nextDealer,
            };
        }
        return snap;
    },

    broadcastState(settleText) {
        if (!this.game) return;
        for (const conn of this.conns.values()) this.sendToConn(conn, this.snapshot(conn, settleText));
    },

    /** 等待某座位的网络动作；广播带 ask 的快照通知该玩家 */
    waitAction(seat, kind, ask) {
        this.lastWaitSeat = seat;
        return new Promise((resolve) => {
            let hasConn = false;
            for (const c of this.conns.values()) if (c.seat === seat) { hasConn = true; break; }
            if (!hasConn) { resolve(null); return; } // 座位已无人：交给 AI 托管
            this.pending = { seat, kind, ask, resolve };
            this.broadcastState();
        });
    },

    /** 校验提示转发给正在操作的座位 */
    forwardToast(msg) {
        if (this.lastWaitSeat >= 0) this.sendToSeat(this.lastWaitSeat, { t: 'toast', msg });
    },

    closeRoom() {
        if (this.transport) this.transport.stop();
        window.location.reload();
    },
};

/* ==================== 网络版 UI 驱动（引擎接口不变） ==================== */

const NetHostUI = {
    log(msg, cls) { UI.log(msg, cls); NetHost.broadcastLog(msg, cls); },
    render(game) { UI.render(game); NetHost.broadcastState(); },
    clearTable() { UI.clearTable(); },
    markWinner(idx) { UI.markWinner(idx); },
    setTurnGlow(idx) { UI.setTurnGlow(idx); },
    toast(msg) { UI.toast(msg); NetHost.forwardToast(msg); },

    async askRevealTrump(twos, firstHand, p) {
        if (!p || !p.remote) return UI.askRevealTrump(twos, firstHand);
        for (;;) {
            const m = await NetHost.waitAction(p.idx, 'reveal', { kind: 'reveal', twos: twos.map(NetProto.ser), firstHand });
            if (m === null) return AI.chooseRevealTrump(p.hand, firstHand); // 掉线托管
            if (!m.chosen) return null;                                     // 玩家选择不亮
            const c = twos.find((x) => NetProto.ser(x) === m.chosen);
            if (c) return c;                                                // 非法 token：重新询问
        }
    },

    async askFanReveal(options, p) {
        if (!p || !p.remote) return UI.askFanReveal(options);
        for (;;) {
            const askOpts = options.map((o) => ({ rank: o.rank, cards: o.cards.map(NetProto.ser) }));
            const m = await NetHost.waitAction(p.idx, 'fan', { kind: 'fan', options: askOpts });
            if (m === null) return options;                                 // 托管：同 AI，全部亮出
            if (!Array.isArray(m.picks) || m.picks.length === 0) return []; // 玩家选择不亮
            const sel = [];
            for (const key of m.picks) {
                const o = options.find((x) => x.rank === key.rank
                    && x.cards.length === (key.cards || []).length
                    && x.cards.every((c, i) => NetProto.ser(c) === key.cards[i]));
                if (o) sel.push(o);
            }
            return sel;
        }
    },

    async askReturnTribute(hand, ctx, payerName, recv) {
        if (!recv || !recv.remote) return UI.askReturnTribute(hand, ctx, payerName);
        for (;;) {
            const m = await NetHost.waitAction(recv.idx, 'tributeBack', { kind: 'tributeBack', payerName });
            if (m === null) return AI.chooseReturnTribute(hand, ctx);       // 掉线托管
            const c = hand.find((x) => NetProto.ser(x) === m.chosen);
            if (c) return c;
        }
    },

    async askBury(hand, ctx, d) {
        if (!d || !d.remote) return UI.askBury(hand, ctx);
        for (;;) {
            const m = await NetHost.waitAction(d.idx, 'bury', { kind: 'bury' });
            if (m === null) return AI.chooseBury(hand, ctx);                // 掉线托管
            const sel = (m.cards || []).map((t) => hand.find((c) => NetProto.ser(c) === t)).filter(Boolean);
            if (sel.length === 6 && new Set(sel).size === 6) {
                const nonPointCnt = hand.filter((c) => cardPoints(c) === 0).length;
                if (!(sel.some((c) => cardPoints(c) > 0) && nonPointCnt >= 6)) return sel;
            }
            // 非法扣底：循环重问（客户端会收到 toast 提示）
        }
    },

    async askPlay(player, game, isLead) {
        if (!player.remote) return UI.askPlay(player, game, isLead);
        const m = await NetHost.waitAction(player.idx, 'play', { kind: 'play', isLead });
        if (m === null) {
            // 掉线托管：启发式快速接管（引擎循环会兜底校验）
            return isLead
                ? AI.heurLead(player.hand, game.ctx, game.otherHands(player.idx))
                : game.fallbackFollow(player);
        }
        const sel = (m.cards || []).map((t) => player.hand.find((c) => NetProto.ser(c) === t)).filter(Boolean);
        return sel; // 合法性由引擎校验循环处理，非法则 toast + 重新询问
    },

    showSettlement(game, text) {
        NetHost.phase = 'settlement';
        NetHost.broadcastState(text);
        return UI.showSettlement(game, text).then((v) => { NetHost.phase = 'playing'; return v; });
    },
};

/* ==================== 房主大厅界面 ==================== */

const HostUI = {
    showLobby(invite) {
        const box = $('net-overlay');
        box.classList.remove('hidden');
        $('net-title').textContent = '联机房间已创建';
        $('net-invite').textContent = invite;
        $('net-start').classList.remove('hidden');
        $('net-sit').classList.add('hidden');
        $('net-wait').classList.add('hidden');
        $('net-start').onclick = () => NetHost.startGame();
        $('net-close-room').onclick = () => NetHost.closeRoom();
        $('net-copy').onclick = () => {
            try { navigator.clipboard.writeText(invite); UI.toast('邀请码已复制'); }
            catch (e) { UI.toast('复制失败，请手动抄写'); }
        };
    },
    updateLobby(names) {
        const el = $('net-seats');
        if (!el) return;
        el.innerHTML = '';
        names.forEach((n, i) => {
            const row = document.createElement('div');
            row.className = 'net-seat-row';
            row.textContent = `座位 ${i}：${n}`;
            el.appendChild(row);
        });
    },
    hideLobby() { $('net-overlay').classList.add('hidden'); },
};
