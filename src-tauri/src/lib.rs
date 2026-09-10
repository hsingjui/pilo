mod domain;
mod runtime;

use runtime::{
    commands::{
        runtime_abort_pi, runtime_get_pi_state, runtime_restart_pi, runtime_send_rpc,
        runtime_spawn_pi, runtime_stop_pi,
    },
    PiloRuntime,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PiloRuntime::default())
        .invoke_handler(tauri::generate_handler![
            runtime_get_pi_state,
            runtime_spawn_pi,
            runtime_stop_pi,
            runtime_restart_pi,
            runtime_abort_pi,
            runtime_send_rpc,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
