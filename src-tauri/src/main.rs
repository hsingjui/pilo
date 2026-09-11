// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|arg| arg == "--pilo-server") {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("failed to create pilo-server runtime");
        runtime
            .block_on(pilo_server::serve_stdio())
            .expect("pilo-server failed");
        return;
    }
    pilo_lib::run()
}
