use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};

use crate::{host_paths::HostPaths, storage};
use pilo_domain::RemoteDevice;

const PAIRING_TTL_MS: u64 = 10 * 60 * 1_000;
const AUTH_CACHE_TOUCH_INTERVAL_MS: u64 = 60 * 1_000;
const AUTH_CACHE_MAX_ENTRIES: usize = 64;

#[derive(Clone)]
struct CachedAuth {
    generation: u64,
    device: RemoteDevice,
    last_db_check_ms: u64,
}

fn auth_cache() -> &'static Mutex<HashMap<(PathBuf, String), CachedAuth>> {
    static CACHE: OnceLock<Mutex<HashMap<(PathBuf, String), CachedAuth>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone)]
pub(crate) struct PairingSecret {
    pub secret: String,
    pub expires_at_ms: u64,
}

#[derive(Clone)]
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

pub(crate) fn normalize_device_name(name: Option<&str>) -> String {
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

pub(crate) fn create_device(
    device_name: Option<&str>,
    pair_ip: &str,
) -> Result<PairedDevice, String> {
    let now_ms = storage::now_ms();
    let token = random_secret(32)?;
    let device = RemoteDevice {
        id: random_secret(16)?,
        name: normalize_device_name(device_name),
        pair_ip: pair_ip.trim().to_owned(),
        created_at_ms: now_ms,
        last_seen_at_ms: now_ms,
        expires_at_ms: now_ms.saturating_add(storage::DEVICE_TOKEN_TTL_MS),
        revoked_at_ms: None,
    };
    Ok(PairedDevice { device, token })
}

/// Fast-path device auth backed by a short-lived in-memory cache keyed by
/// `(db_path, token_hash)` and invalidated immediately on `auth_generation` bumps.
pub(crate) fn authenticate_cached(
    paths: &HostPaths,
    token: &str,
    auth_generation: u64,
) -> Result<Option<RemoteDevice>, String> {
    if token.len() < 32 || token.len() > 128 {
        return Ok(None);
    }
    let now_ms = storage::now_ms();
    let token_hash = hash_credential(token);
    let db_path = paths.database_path()?;
    let cache_key = (db_path, token_hash.clone());
    if let Ok(cache) = auth_cache().lock()
        && let Some(entry) = cache.get(&cache_key)
        && entry.generation == auth_generation
        && now_ms < entry.device.expires_at_ms
        && now_ms.saturating_sub(entry.last_db_check_ms) < AUTH_CACHE_TOUCH_INTERVAL_MS
    {
        return Ok(Some(entry.device.clone()));
    }
    let db = storage::open_with_paths(paths)?;
    let device = storage::authenticate_remote_device(&db, &token_hash, now_ms)?;
    if let Ok(mut cache) = auth_cache().lock() {
        match &device {
            Some(device) => {
                if cache.len() >= AUTH_CACHE_MAX_ENTRIES {
                    cache.clear();
                }
                cache.insert(
                    cache_key,
                    CachedAuth {
                        generation: auth_generation,
                        device: device.clone(),
                        last_db_check_ms: now_ms,
                    },
                );
            }
            None => {
                cache.remove(&cache_key);
            }
        }
    }
    Ok(device)
}

/// 把当前设备的有效期重置为从现在起的完整 TTL；token 不变。
/// 设备已撤销或过期时返回 `None`。
pub(crate) fn renew_device(paths: &HostPaths, device_id: &str) -> Result<Option<u64>, String> {
    let mut db = storage::open_with_paths(paths)?;
    storage::renew_remote_device(&mut db, device_id, storage::DEVICE_TOKEN_TTL_MS)
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
