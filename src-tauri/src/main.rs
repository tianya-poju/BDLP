#![cfg_attr(all(windows, not(test)), windows_subsystem = "windows")]

#[cfg(not(target_os = "android"))]
fn main() {
    budao_lepao_lib::run();
}

#[cfg(target_os = "android")]
fn main() {}
