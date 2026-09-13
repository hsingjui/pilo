const SSH_KEYRING_SERVICE: &str = "app.pilo.ssh";

fn entry(connection_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SSH_KEYRING_SERVICE, connection_id)
        .map_err(|error| format!("failed to access the system credential store: {error}"))
}

pub fn set_ssh_password(connection_id: &str, password: &str) -> Result<(), String> {
    if password.is_empty() {
        return Err("SSH password cannot be empty".to_owned());
    }
    entry(connection_id)?
        .set_password(password)
        .map_err(|error| format!("failed to save SSH password: {error}"))
}

pub fn get_ssh_password(connection_id: &str) -> Result<String, String> {
    entry(connection_id)?
        .get_password()
        .map_err(|error| format!("failed to read SSH password: {error}"))
}

pub fn has_ssh_password(connection_id: &str) -> bool {
    get_ssh_password(connection_id).is_ok()
}

pub fn delete_ssh_password(connection_id: &str) -> Result<(), String> {
    let entry = entry(connection_id)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("failed to remove SSH password: {error}")),
    }
}
