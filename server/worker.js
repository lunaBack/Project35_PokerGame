/**
 * 三五反 · Cloudflare Worker 房间中继（纯转接，无状态存储）
 *
 * 架构：每个房间码对应一个 Durable Object 实例（保证全局唯一落点），
 *       房主与房员的 WebSocket 都汇聚到同一实例内互转。
 *       Worker 只搬运字节，游戏权威仍在房主端；无 KV/持久化，免费额度足够。
 *
 *   房主:   wss://<worker>/room/<CODE>?role=host     （首个连接者即房主）
 *   房员:   wss://<worker>/room/<CODE>?role=member
 *
 * 信封协议（房主单连接多路复用）：
 *   Worker → 房主: { p:'open', id } | { p:'msg', id, d } | { p:'close', id }
 *   房主 → Worker: { p:'msg', id, d }   （d 为原样转发给房员的游戏 JSON 文本）
 *   Worker → 房员: 房主发来的 d 原文（无信封）；房间不存在/已满时发 { p:'err', msg }
 */

export default {
    fetch(request, env) {
        const url = new URL(request.url);
        const m = url.pathname.match(/^\/room\/([A-Za-z0-9]{2,8})$/);
        if (!m) return new Response('sanwufan relay: use /room/<CODE>', { status: 200 });
        if (request.headers.get('Upgrade') !== 'websocket') {
            return new Response('expected websocket', { status: 426 });
        }
        const code = m[1].toUpperCase();
        const role = url.searchParams.get('role') === 'host' ? 'host' : 'member';
        // 同一 code 恒映射到同一 DO 实例
        const id = env.ROOM.idFromName(code);
        const stub = env.ROOM.get(id);
        return stub.fetch(new Request('https://room/join?role=' + role, { headers: request.headers }));
    },
};

/** 每个房间一个实例：房主在则房间在，房主断开即清理并关闭所有房员 */
export class Room {
    constructor(state, env) {
        this.host = null;          // 房主 WebSocket（server 侧）
        this.members = new Map();  // id -> WebSocket
        this.nextId = 1;
    }

    async fetch(request) {
        const role = new URL(request.url).searchParams.get('role') === 'host' ? 'host' : 'member';
        const pair = new WebSocketPair();
        const [cSock, sSock] = Object.values(pair);
        sSock.accept();

        if (role === 'host') {
            if (this.host) {
                sSock.send(JSON.stringify({ p: 'err', msg: 'room busy' }));
                sSock.close(1000, 'busy');
                return new Response(null, { status: 101, webSocket: cSock });
            }
            this.host = sSock;
            sSock.addEventListener('close', () => {
                this.host = null;
                for (const ws of this.members.values()) {
                    try { ws.close(1000, 'host gone'); } catch (e) {}
                }
                this.members.clear();
            });
            sSock.addEventListener('message', (ev) => {
                let env2;
                try { env2 = JSON.parse(ev.data); } catch (e) { return; }
                if (env2 && env2.p === 'msg') {
                    const t = this.members.get(env2.id);
                    if (t) { try { t.send(env2.d); } catch (e) {} }
                }
            });
            return new Response(null, { status: 101, webSocket: cSock });
        }

        // ---- 房员 ----
        if (!this.host) {
            sSock.send(JSON.stringify({ p: 'err', msg: 'no such room' }));
            sSock.close(1000, 'no room');
            return new Response(null, { status: 101, webSocket: cSock });
        }
        const id = this.nextId++;
        this.members.set(id, sSock);
        const notifyHost = (obj) => {
            if (this.host) { try { this.host.send(JSON.stringify(obj)); } catch (e) {} }
        };
        notifyHost({ p: 'open', id });
        sSock.addEventListener('message', (ev) => notifyHost({ p: 'msg', id, d: String(ev.data) }));
        sSock.addEventListener('close', () => {
            this.members.delete(id);
            notifyHost({ p: 'close', id });
        });
        return new Response(null, { status: 101, webSocket: cSock });
    }
}
