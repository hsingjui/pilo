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
    #[cfg(unix)]
    if let Some(mode) = std::env::args().nth(1)
        && matches!(mode.as_str(), "--ssh-bridge" | "--ssh-daemon")
    {
        let scope = std::env::args().nth(2).ok_or("missing SSH runtime scope")?;
        if mode == "--ssh-bridge" {
            let result = pilo_server::ssh_daemon::bridge(&scope).await;
            // Tokio stdin can still have a blocking read pending after socket EOF.
            if let Err(error) = result {
                eprintln!("SSH runtime bridge: {error}");
                std::process::exit(1);
            }
            std::process::exit(0);
        }
        return Ok(pilo_server::ssh_daemon::serve(&scope).await?);
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
