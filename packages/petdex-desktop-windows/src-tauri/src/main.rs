// release 构建时使用 windows 子系统，避免 GUI 应用启动时弹出控制台黑窗
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    petdex_win_lib::run();
}
