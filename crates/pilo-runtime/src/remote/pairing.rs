use std::{collections::HashMap, sync::Mutex};

use serde::Serialize;

use crate::{host_paths::HostPaths, storage};
use pilo_domain::{RemoteAccessAddress, RemoteScopes};

use super::auth::{self, PairedDevice};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairingAddress {
    #[serde(flatten)]
    pub address: RemoteAccessAddress,
    pub issued: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairingInfo {
    pub addresses: Vec<PairingAddress>,
    pub expires_at_ms: u64,
    pub remaining_uses: usize,
    pub scopes: RemoteScopes,
}

pub(crate) enum PairingError {
    Unauthorized,
    InvalidRequest(&'static str),
    AlreadyUsed,
    Internal(String),
}

struct Receipt {
    request_hash: String,
    paired: PairedDevice,
}

struct ActivePairing {
    secret: String,
    secret_hash: String,
    expires_at_ms: u64,
    scopes: RemoteScopes,
    addresses: Vec<RemoteAccessAddress>,
    receipts: HashMap<String, Receipt>,
}

impl ActivePairing {
    fn info(&self) -> PairingInfo {
        PairingInfo {
            addresses: self
                .addresses
                .iter()
                .map(|address| PairingAddress {
                    issued: self.receipts.contains_key(&address.id),
                    address: address.clone(),
                })
                .collect(),
            expires_at_ms: self.expires_at_ms,
            scopes: self.scopes,
            remaining_uses: self.addresses.len().saturating_sub(self.receipts.len()),
        }
    }
}

#[derive(Default)]
pub(crate) struct PairingSession {
    active: Mutex<Option<ActivePairing>>,
}

impl PairingSession {
    pub(crate) fn regenerate(
        &self,
        paths: &HostPaths,
        addresses: Vec<RemoteAccessAddress>,
        scopes: RemoteScopes,
    ) -> Result<(), String> {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *active = None;
        if addresses.is_empty() {
            storage::clear_remote_pairing(&storage::open_with_paths(paths)?)?;
            return Err("Remote WebUI needs a valid access address".to_owned());
        }
        let pairing = auth::issue_pairing(paths, scopes)?;
        *active = Some(ActivePairing {
            secret_hash: auth::hash_credential(&pairing.secret),
            secret: pairing.secret,
            expires_at_ms: pairing.expires_at_ms,
            scopes,
            addresses,
            receipts: HashMap::new(),
        });
        Ok(())
    }

    pub(crate) fn invalidate(&self) {
        *self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }

    pub(crate) fn snapshot(&self) -> Option<(String, PairingInfo)> {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if active
            .as_ref()
            .is_some_and(|pairing| pairing.expires_at_ms <= storage::now_ms())
        {
            *active = None;
        }
        active
            .as_ref()
            .map(|pairing| (pairing.secret.clone(), pairing.info()))
    }

    pub(crate) fn expire(&self) {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if active
            .as_ref()
            .is_some_and(|pairing| pairing.expires_at_ms <= storage::now_ms())
        {
            *active = None;
        }
    }

    pub(crate) fn describe(&self, secret: &str) -> Result<PairingInfo, PairingError> {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Ok(Self::authorized(&mut active, secret)?.info())
    }

    pub(crate) fn exchange(
        &self,
        paths: &HostPaths,
        secret: &str,
        address_id: &str,
        request_id: &str,
        device_name: Option<&str>,
        pair_ip: &str,
    ) -> Result<PairedDevice, PairingError> {
        if request_id.len() != 64 || !request_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(PairingError::InvalidRequest(
                "invalid pairing request proof",
            ));
        }
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let pairing = Self::authorized(&mut active, secret)?;
        let address = pairing
            .addresses
            .iter()
            .find(|address| address.id == address_id)
            .ok_or(PairingError::InvalidRequest("unknown pairing address"))?;
        let request_hash = auth::hash_credential(request_id);
        let mut db = storage::open_with_paths(paths).map_err(PairingError::Internal)?;
        if let Some(receipt) = pairing.receipts.get(address_id) {
            if receipt.request_hash != request_hash {
                return Err(PairingError::AlreadyUsed);
            }
            let device = storage::authenticate_remote_device(
                &db,
                &auth::hash_credential(&receipt.paired.token),
                storage::now_ms(),
            )
            .map_err(PairingError::Internal)?
            .ok_or(PairingError::Unauthorized)?;
            if pairing.expires_at_ms <= storage::now_ms() {
                return Err(PairingError::Unauthorized);
            }
            return Ok(PairedDevice {
                device,
                token: receipt.paired.token.clone(),
            });
        }
        let label = if address.name.is_empty() {
            &address.base_url
        } else {
            &address.name
        };
        let display_name: String = auth::normalize_device_name(device_name)
            .chars()
            .take(40)
            .collect();
        let name = format!(
            "{display_name} · {}",
            label.chars().take(36).collect::<String>()
        );
        let mut paired = auth::create_device(Some(&name), pair_ip, pairing.scopes)
            .map_err(PairingError::Internal)?;
        paired.device.display_name = Some(display_name.trim_end().to_owned());
        let exhausted = pairing.receipts.len() + 1 == pairing.addresses.len();
        if !storage::insert_remote_pairing_device(
            &mut db,
            &pairing.secret_hash,
            &paired.device,
            &auth::hash_credential(&paired.token),
            exhausted,
        )
        .map_err(PairingError::Internal)?
        {
            return Err(PairingError::Unauthorized);
        }
        // No await between the SQL commit and this receipt: cancelled HTTP requests can safely retry.
        pairing.receipts.insert(
            address_id.to_owned(),
            Receipt {
                request_hash,
                paired: paired.clone(),
            },
        );
        Ok(paired)
    }

    fn authorized<'a>(
        active: &'a mut Option<ActivePairing>,
        secret: &str,
    ) -> Result<&'a mut ActivePairing, PairingError> {
        if active
            .as_ref()
            .is_some_and(|pairing| pairing.expires_at_ms <= storage::now_ms())
        {
            *active = None;
        }
        let pairing = active.as_mut().ok_or(PairingError::Unauthorized)?;
        if !(32..=128).contains(&secret.len())
            || pairing.secret_hash != auth::hash_credential(secret)
        {
            return Err(PairingError::Unauthorized);
        }
        Ok(pairing)
    }
}
