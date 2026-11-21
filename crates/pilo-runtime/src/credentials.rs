use std::{io::Write, time::Instant};

const SSH_KEYRING_SERVICE: &str = "app.pilo.ssh";

fn log_access<T>(
    connection_id: &str,
    operation: &'static str,
    started: Instant,
    result: &Result<T, keyring::Error>,
) {
    let reason = match result {
        Ok(_) => "none",
        Err(keyring::Error::NoEntry) => "credential_missing",
        Err(keyring::Error::NoStorageAccess(_)) => "credential_access_denied",
        Err(keyring::Error::PlatformFailure(_)) => "credential_platform_failure",
        Err(keyring::Error::BadEncoding(_)) => "credential_bad_encoding",
        Err(keyring::Error::TooLong(_, _) | keyring::Error::Invalid(_, _)) => "credential_invalid",
        Err(keyring::Error::Ambiguous(_)) => "credential_ambiguous",
        Err(_) => "credential_unknown",
    };
    let record = format!(
        "credential access pid={} connectionId={connection_id:?} operation={operation} ok={} elapsedMs={} reason={reason}",
        std::process::id(),
        result.is_ok(),
        started.elapsed().as_millis()
    );
    // Askpass exits before Tauri initializes the logger. Its stderr is captured by SSH.
    if std::env::var_os(super::ssh::ASKPASS_CONNECTION_ENV).is_some() {
        if let Some(attempt_id) = std::env::var(super::ssh::ASKPASS_ATTEMPT_ENV)
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
        {
            let _ = writeln!(
                std::io::stderr().lock(),
                "{} attemptId={attempt_id} {record}",
                super::ssh::ASKPASS_DIAGNOSTIC_PREFIX
            );
        }
    } else if result.is_err() {
        log::warn!(target: "connection-diagnostics", "{record}");
    } else {
        log::info!(target: "connection-diagnostics", "{record}");
    }
}

fn entry(connection_id: &str) -> Result<keyring::Entry, String> {
    let started = Instant::now();
    let result = keyring::Entry::new(SSH_KEYRING_SERVICE, connection_id);
    if result.is_err() {
        log_access(connection_id, "open", started, &result);
    }
    result.map_err(|error| format!("failed to access the system credential store: {error}"))
}

pub fn set_ssh_password(connection_id: &str, password: &str) -> Result<(), String> {
    if password.is_empty() {
        return Err("SSH password cannot be empty".to_owned());
    }
    let started = Instant::now();
    let result = entry(connection_id)?.set_password(password);
    log_access(connection_id, "write", started, &result);
    result.map_err(|error| format!("failed to save SSH password: {error}"))
}

pub fn get_ssh_password(connection_id: &str) -> Result<String, String> {
    let started = Instant::now();
    let result = entry(connection_id)?.get_password();
    log_access(connection_id, "read", started, &result);
    result.map_err(|error| format!("failed to read SSH password: {error}"))
}

pub fn has_ssh_password(connection_id: &str) -> bool {
    // Listing connections probes missing entries routinely; do not log each probe.
    entry(connection_id).is_ok_and(|entry| entry.get_password().is_ok())
}

pub fn delete_ssh_password(connection_id: &str) -> Result<(), String> {
    let started = Instant::now();
    let entry = entry(connection_id)?;
    let result = match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error),
    };
    log_access(connection_id, "delete", started, &result);
    result.map_err(|error| format!("failed to remove SSH password: {error}"))
}
