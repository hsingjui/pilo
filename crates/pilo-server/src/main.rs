#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
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
