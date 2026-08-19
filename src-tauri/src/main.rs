// 防止 Windows 发布构建时弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    sanwufan_lib::run()
}
