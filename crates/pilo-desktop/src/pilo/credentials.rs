//! Device tokens for paired remote Hosts, kept in the system credential store.

const REMOTE_HOST_KEYRING_SERVICE: &str = "app.pilo.remote-host";

fn entry(host_id: &str) -> Result<keyring::Entry, String> {
    if host_id.is_empty() {
        return Err("remote Host id cannot be empty".to_owned());
    }
    keyring::Entry::new(REMOTE_HOST_KEYRING_SERVICE, host_id)
        .map_err(|error| format!("failed to access the system credential store: {error}"))
}

pub(super) fn get_remote_host_token(host_id: &str) -> Result<Option<String>, String> {
    match entry(host_id)?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("failed to read the remote Host token: {error}")),
    }
}

pub(super) fn set_remote_host_token(host_id: &str, token: &str) -> Result<(), String> {
    if token.is_empty() {
        return Err("remote Host token cannot be empty".to_owned());
    }
    entry(host_id)?
        .set_password(token)
        .map_err(|error| format!("failed to save the remote Host token: {error}"))
}

pub(super) fn delete_remote_host_token(host_id: &str) -> Result<(), String> {
    match entry(host_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("failed to delete the remote Host token: {error}")),
    }
}

/// The machine's host name, or `None` when the platform does not report one.
pub(super) fn machine_name() -> Option<String> {
    for key in ["HOSTNAME", "COMPUTERNAME"] {
        if let Ok(value) = std::env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_owned());
            }
        }
    }
    #[cfg(unix)]
    if let Ok(output) = std::process::Command::new("hostname").arg("-s").output()
        && output.status.success()
        && let Ok(name) = String::from_utf8(output.stdout)
    {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_owned());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_host_ids_and_tokens() {
        assert!(get_remote_host_token("").is_err());
        assert!(set_remote_host_token("host", "").is_err());
        assert!(delete_remote_host_token("").is_err());
    }
}
