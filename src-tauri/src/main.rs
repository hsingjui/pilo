// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![windows_subsystem = "windows"]

fn main() {
    if pilo_lib::handle_ssh_askpass() {
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("ctl") {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("failed to create ctl runtime");
        if let Err(error) = runtime.block_on(pilo_server::control::run_cli(
            std::env::args().skip(2).collect(),
        )) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
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
