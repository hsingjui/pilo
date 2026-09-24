use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};

use crate::{
    domain::RemoteDevice,
    runtime::{host_paths::HostPaths, storage},
};

const PAIRING_TTL_MS: u64 = 5 * 60 * 1_000;
const DEVICE_TOKEN_TTL_MS: u64 = 30 * 24 * 60 * 60 * 1_000;

#[derive(Clone, Debug)]
pub(crate) struct PairingSecret {
    pub secret: String,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct PairedDevice {
    pub device: RemoteDevice,
    pub token: String,
}

fn random_secret(bytes: usize) -> Result<String, String> {
    let mut value = vec![0_u8; bytes];
    getrandom::fill(&mut value)
        .map_err(|error| format!("failed to generate Remote WebUI credential: {error}"))?;
    Ok(URL_SAFE_NO_PAD.encode(value))
}

pub(crate) fn hash_credential(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    format!("{digest:x}")
}

fn normalize_device_name(name: Option<&str>) -> String {
    let name = name.unwrap_or_default().trim();
    if name.is_empty() {
        return "Remote device".to_owned();
    }
    let mut normalized = name.chars().take(80).collect::<String>();
    if name.chars().count() > 80 {
        normalized.push('…');
    }
    normalized
}

pub(crate) fn issue_pairing(paths: &HostPaths) -> Result<PairingSecret, String> {
    let now_ms = storage::now_ms();
    let secret = random_secret(32)?;
    let expires_at_ms = now_ms.saturating_add(PAIRING_TTL_MS);
    let db = storage::open_with_paths(paths)?;
    storage::replace_remote_pairing(&db, &hash_credential(&secret), expires_at_ms)?;
    Ok(PairingSecret {
        secret,
        expires_at_ms,
    })
}

pub(crate) fn exchange_pairing(
    paths: &HostPaths,
    secret: &str,
    device_name: Option<&str>,
) -> Result<Option<PairedDevice>, String> {
    if secret.len() < 32 || secret.len() > 128 {
        return Ok(None);
    }
    let now_ms = storage::now_ms();
    let mut db = storage::open_with_paths(paths)?;
    if !storage::consume_remote_pairing(&mut db, &hash_credential(secret), now_ms)? {
        return Ok(None);
    }

    let token = random_secret(32)?;
    let device = RemoteDevice {
        id: random_secret(16)?,
        name: normalize_device_name(device_name),
        created_at_ms: now_ms,
        last_seen_at_ms: now_ms,
        expires_at_ms: now_ms.saturating_add(DEVICE_TOKEN_TTL_MS),
        revoked_at_ms: None,
    };
    storage::insert_remote_device(&db, &device, &hash_credential(&token))?;
    Ok(Some(PairedDevice { device, token }))
}

pub(crate) fn authenticate(paths: &HostPaths, token: &str) -> Result<Option<RemoteDevice>, String> {
    if token.len() < 32 || token.len() > 128 {
        return Ok(None);
    }
    let db = storage::open_with_paths(paths)?;
    storage::authenticate_remote_device(&db, &hash_credential(token), storage::now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalized_device_names_are_bounded() {
        assert_eq!(normalize_device_name(None), "Remote device");
        assert_eq!(normalize_device_name(Some("  Phone  ")), "Phone");
        let long = "x".repeat(100);
        let normalized = normalize_device_name(Some(&long));
        assert_eq!(normalized.chars().count(), 81);
        assert!(normalized.ends_with('…'));
    }

    #[test]
    fn credential_hash_is_stable_and_not_plaintext() {
        let hash = hash_credential("pairing-secret");
        assert_eq!(hash.len(), 64);
        assert_ne!(hash, "pairing-secret");
        assert_eq!(hash, hash_credential("pairing-secret"));
    }
}
