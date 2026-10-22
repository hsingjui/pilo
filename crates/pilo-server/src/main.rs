#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().nth(1).as_deref() == Some("ctl") {
        if let Err(error) = pilo_server::control::run_cli(std::env::args().skip(2).collect()).await
        {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return Ok(());
    }
    if std::env::args().any(|arg| arg == "--version") {
        println!("{}", pilo_server::SERVER_VERSION);
        return Ok(());
    }
    if std::env::args().any(|arg| arg == "--fingerprint") {
        let executable = std::env::current_exe()?;
        println!("{}", pilo_server::binary_fingerprint(&executable)?);
        return Ok(());
    }
    pilo_server::serve_stdio().await
}
