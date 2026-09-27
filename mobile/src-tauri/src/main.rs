// 移动端入口桩：真正逻辑在 lib.rs（tauri::mobile_entry_point）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    wotb_agent_mobile::run()
}
