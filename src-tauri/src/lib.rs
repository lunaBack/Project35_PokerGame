mod net;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 外部导航防护：前端无外链，且 ui.js 中已加锚点点击拦截；CSP 见 tauri.conf.json
    tauri::Builder::default()
        .manage(std::sync::Arc::new(net::NetState::new()))
        .invoke_handler(tauri::generate_handler![
            net::net_listen,
            net::net_send,
            net::net_disconnect,
            net::net_stop,
            net::net_local_ip,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
