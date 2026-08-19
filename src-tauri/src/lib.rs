#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 外部导航防护：前端无外链，且 ui.js 中已加锚点点击拦截；CSP 见 tauri.conf.json
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
