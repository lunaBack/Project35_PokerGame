/**
 * net_proto.js —— 联机协议常量与卡牌编码（房主/房员共享）
 * 消息均为 JSON 文本，类型字段 t：
 *   客户端→房主: hello / action / sit
 *   房主→客户端: welcome / reject / lobby / state / log / toast
 * 房主是权威端：客户端只发"意图"，合法性全部由房主引擎校验。
 */
'use strict';

const NET_VER = 1;        // 协议版本：连接时握手校验，版本不一致直接拒绝
const NET_PORT = 47535;   // 房主默认监听端口（被占用自动顺延）
const NET_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去除易混淆的 0/O/1/I

// 公网中继（Cloudflare Worker）地址：空字符串 = 仅局域网直连模式
// 注意：workers.dev 域名在国内需代理访问（Tauri 内 WebView2 自动跟随系统代理）
const NET_RELAY_URL = 'wss://sanwufan-relay.project35.workers.dev';

/** token（'spadeQ'/'BJ'）→ 稳定 id（0..53），供客户端重建牌对象 */
const NET_CARD_ID = {};
/** id → token 反查 */
const NET_ID_TOKEN = [];
{
    const suits = ['spade', 'heart', 'club', 'diamond'];
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    let i = 0;
    for (const s of suits) for (const r of ranks) {
        const tok = s + r;
        NET_CARD_ID[tok] = i;
        NET_ID_TOKEN[i] = tok;
        i++;
    }
    NET_CARD_ID['BJ'] = 52; NET_ID_TOKEN[52] = 'BJ';
    NET_CARD_ID['SJ'] = 53; NET_ID_TOKEN[53] = 'SJ';
}

const NetProto = {
    /** 牌对象 → token */
    ser(c) { return c.suit === 'joker' ? c.rank : c.suit + c.rank; },
    /** token → 伪牌对象（客户端渲染用，id 稳定） */
    parse(tok) {
        const id = NET_CARD_ID[tok];
        if (tok === 'BJ' || tok === 'SJ') return { id, suit: 'joker', rank: tok };
        const suit = tok.slice(0, tok.length - (tok.includes('10') ? 2 : 1)) ;
        const rank = tok.slice(suit.length);
        return { id, suit, rank };
    },
    makeCode(len) {
        let s = '';
        for (let i = 0; i < (len || 4); i++) {
            s += NET_CODE_CHARS[Math.floor(Math.random() * NET_CODE_CHARS.length)];
        }
        return s;
    },
    /** 解析邀请："CODE@IP:PORT"（直连）/ 含 ":" 的 "IP:PORT"（直连）/ 纯 4 位码（经中继） */
    parseInvite(str) {
        str = String(str || '').trim();
        const at = str.indexOf('@');
        if (at >= 0) return { code: str.slice(0, at).trim().toUpperCase(), host: str.slice(at + 1).trim() };
        if (str.includes(':')) return { code: '', host: str };
        if (/^[A-Za-z0-9]{2,8}$/.test(str)) return { code: str.toUpperCase(), host: '' };
        return { code: '', host: '' };
    },
};
