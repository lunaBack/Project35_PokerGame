// net.rs —— 联机模块：房主端内嵌 WebSocket 服务端（传输层）
// 职责仅限"收发文本消息"：连接建立/消息/断开 通过 Tauri 事件 net:event 通知前端；
// 房间、协议、游戏逻辑全部在 JS 侧（host.js），Rust 对协议内容完全透明。
use std::collections::HashMap;
use std::net::{TcpListener, UdpSocket};
use std::sync::Mutex;

use futures_util::{SinkExt, StreamExt};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

/// 发给连接写循环的指令
enum WsCmd {
    Text(String),
    Close,
}

#[derive(Default)]
pub struct NetState {
    conns: Mutex<HashMap<u32, mpsc::UnboundedSender<WsCmd>>>,
    next_id: Mutex<u32>,
    shutdown: Mutex<Option<mpsc::UnboundedSender<()>>>,
}

impl NetState {
    /// Tauri 同步命令不在 Tokio 上下文中，需自建专属 runtime（创建时即启动）
    pub fn new() -> Self {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("net-ws")
            .build()
            .expect("无法创建 Tokio runtime");
        RT.set(rt).expect("NetState 重复初始化");
        Self::default()
    }
}

/// 专属网络 runtime（随 NetState::new 初始化）
static RT: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
fn rt() -> &'static tokio::runtime::Runtime {
    RT.get().expect("NetState 未初始化")
}

#[derive(serde::Serialize, Clone)]
struct NetEvent {
    kind: String, // open | msg | close
    id: u32,
    data: String,
}

fn emit(app: &AppHandle, kind: &str, id: u32, data: String) {
    let _ = app.emit("net:event", NetEvent { kind: kind.into(), id, data });
}

/// 启动 WebSocket 服务监听。port 被占用时自动顺延尝试。返回实际端口。
#[tauri::command]
pub fn net_listen(app: AppHandle, state: State<'_, std::sync::Arc<NetState>>, port: u16) -> Result<u16, String> {
    let mut listener = None;
    for p in port..port.saturating_add(20) {
        if let Ok(l) = TcpListener::bind(("0.0.0.0", p)) {
            listener = Some(l);
            break;
        }
    }
    let listener = listener.ok_or_else(|| format!("端口 {} 起连续被占用", port))?;
    let real_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let listener = rt()
        .block_on(async { tokio::net::TcpListener::from_std(listener) })
        .map_err(|e| e.to_string())?;

    let (stop_tx, mut stop_rx) = mpsc::unbounded_channel::<()>();
    *state.shutdown.lock().unwrap() = Some(stop_tx);

    let st = state.inner().clone();
    rt().spawn(async move {
        loop {
            tokio::select! {
                _ = stop_rx.recv() => break,
                acc = listener.accept() => {
                    let (stream, _addr) = match acc { Ok(v) => v, Err(_) => continue };
                    let id = {
                        let mut n = st.next_id.lock().unwrap();
                        *n += 1;
                        *n
                    };
                    let app2 = app.clone();
                    let st2 = st.clone();
                    rt().spawn(async move {
                        handle_conn(app2, st2, id, stream).await;
                    });
                }
            }
        }
        // 停止监听时关闭所有连接（前端会收到 close 事件）
        let ids: Vec<u32> = st.conns.lock().unwrap().keys().copied().collect();
        for id in ids {
            close_conn(&st, id);
        }
    });
    Ok(real_port)
}

async fn handle_conn(app: AppHandle, st: std::sync::Arc<NetState>, id: u32, stream: tokio::net::TcpStream) {
    let ws = match tokio_tungstenite::accept_async(stream).await {
        Ok(ws) => ws,
        Err(_) => return,
    };
    let (tx, mut rx) = mpsc::unbounded_channel::<WsCmd>();
    st.conns.lock().unwrap().insert(id, tx);
    emit(&app, "open", id, String::new());

    let (mut sink, mut stream_rx) = ws.split();
    loop {
        tokio::select! {
            cmd = rx.recv() => {
                match cmd {
                    Some(WsCmd::Text(t)) => {
                        if sink.send(Message::Text(t)).await.is_err() { break; }
                    }
                    Some(WsCmd::Close) | None => {
                        let _ = sink.send(Message::Close(None)).await;
                        break;
                    }
                }
            }
            msg = stream_rx.next() => {
                match msg {
                    Some(Ok(Message::Text(t))) => emit(&app, "msg", id, t),
                    Some(Ok(Message::Ping(d))) => { if sink.send(Message::Pong(d)).await.is_err() { break; } }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }
    st.conns.lock().unwrap().remove(&id);
    emit(&app, "close", id, String::new());
}

fn close_conn(st: &NetState, id: u32) {
    if let Some(tx) = st.conns.lock().unwrap().get(&id) {
        let _ = tx.send(WsCmd::Close);
    }
}

/// 向指定连接发送文本消息
#[tauri::command]
pub fn net_send(state: State<'_, std::sync::Arc<NetState>>, id: u32, text: String) -> Result<(), String> {
    match state.conns.lock().unwrap().get(&id) {
        Some(tx) => tx.send(WsCmd::Text(text)).map_err(|e| e.to_string()),
        None => Err("连接不存在".into()),
    }
}

/// 主动断开指定连接
#[tauri::command]
pub fn net_disconnect(state: State<'_, std::sync::Arc<NetState>>, id: u32) {
    close_conn(&state, id);
}

/// 停止监听并断开所有连接（关闭房间）
#[tauri::command]
pub fn net_stop(state: State<'_, std::sync::Arc<NetState>>) {
    if let Some(tx) = state.shutdown.lock().unwrap().take() {
        let _ = tx.send(());
    }
}

/// 获取本机局域网 IP（UDP 出口探测，不实际发包）
#[tauri::command]
pub fn net_local_ip() -> String {
    if let Ok(s) = UdpSocket::bind("0.0.0.0:0") {
        if s.connect("8.8.8.8:80").is_ok() {
            if let Ok(a) = s.local_addr() {
                return a.ip().to_string();
            }
        }
    }
    "127.0.0.1".into()
}
