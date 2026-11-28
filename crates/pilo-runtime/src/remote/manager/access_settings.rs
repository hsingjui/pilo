use super::{DEFAULT_PAIRING_SCOPES, RemoteHostState, RemoteServerManager, access};
use crate::host_paths::HostPaths;
use crate::{Runtime, storage};
use pilo_domain::{RemoteAccessAddress, RemoteAccessConfig, RemoteHostConfig};
use rusqlite::Connection as SqliteConnection;
use std::net::{IpAddr, Ipv4Addr, UdpSocket};

pub(super) async fn read_host_access(
    paths: &HostPaths,
) -> Result<(RemoteHostConfig, storage::StoredRemoteAccess), String> {
    let paths = paths.clone();
    tokio::task::spawn_blocking(move || {
        let db = storage::open_with_paths(&paths)?;
        Ok((
            storage::get_remote_host_config(&db)?,
            storage::get_remote_access_config(&db)?,
        ))
    })
    .await
    .map_err(|_| "Remote WebUI address task failed".to_owned())?
}

pub(super) fn load_access_config(
    db: &SqliteConnection,
    lan_base_url: Option<&str>,
) -> Result<RemoteAccessConfig, String> {
    let stored = storage::get_remote_access_config(db)?;
    if let Some(addresses) = stored.addresses {
        return Ok(RemoteAccessConfig {
            addresses,
            entry_address_id: stored.entry_address_id,
        });
    }
    let lan_base_url = lan_base_url.ok_or("Remote WebUI has no access addresses")?;
    let host = storage::get_remote_host_config(db)?;
    Ok(access::default_config(
        lan_base_url,
        &host.public_base_url,
        &stored.entry_address_id,
    ))
}

pub(super) fn direct_lan_host(addresses: &[RemoteAccessAddress], port: u16) -> Option<&str> {
    let address = addresses.iter().find(|address| address.id == "lan")?;
    let (host, url_port) = address.base_url.strip_prefix("http://")?.rsplit_once(':')?;
    (host.parse::<Ipv4Addr>().is_ok() && url_port.parse::<u16>() == Ok(port)).then_some(host)
}

pub(super) async fn resolve_managed_lan_ip(
    addresses: &[RemoteAccessAddress],
    port: u16,
    saved_ip: Option<&str>,
) -> String {
    match (direct_lan_host(addresses, port), saved_ip) {
        (Some(host), Some(ip)) if host == ip => ip.to_owned(),
        (Some(host), None) if host.parse::<IpAddr>().ok() == Some(lan_ip().await) => {
            host.to_owned()
        }
        _ => String::new(),
    }
}

pub(super) fn trim_base_url(input: &str) -> &str {
    input.trim().trim_end_matches('/')
}

pub(super) fn effective_base_url(public_base_url: &str, lan_base_url: &str) -> String {
    let configured = trim_base_url(public_base_url);
    if configured.is_empty() {
        lan_base_url.to_owned()
    } else {
        configured.to_owned()
    }
}

pub(super) async fn lan_ip() -> IpAddr {
    if let Ok(ips) = super::super::lan::list_lan_ips().await
        && let Some(ip) = ips.into_iter().find_map(|raw| raw.parse::<Ipv4Addr>().ok())
    {
        return IpAddr::V4(ip);
    }
    if let Ok(socket) = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        && socket.connect((Ipv4Addr::new(8, 8, 8, 8), 80)).is_ok()
        && let Ok(address) = socket.local_addr()
        && let IpAddr::V4(ip) = address.ip()
        && !ip.is_unspecified()
        && !ip.is_loopback()
        && !ip.is_link_local()
    {
        return IpAddr::V4(ip);
    }
    IpAddr::V4(Ipv4Addr::LOCALHOST)
}

impl RemoteServerManager {
    pub(crate) async fn set_addresses(
        &self,
        runtime: &Runtime,
        config: RemoteAccessConfig,
    ) -> Result<RemoteHostState, String> {
        let config = access::normalize_config(config)?;
        let _lifecycle = self.lifecycle.lock().await;
        let paths = runtime.paths.clone();
        let (host, stored) = read_host_access(&paths).await?;
        let mut inner = self.inner.lock().await;
        let port = inner
            .running
            .as_ref()
            .map_or(host.port, |running| running.port);
        let (before, managed_lan_ip) = match stored.addresses {
            Some(addresses) => {
                let managed_lan_ip =
                    resolve_managed_lan_ip(&addresses, port, stored.managed_lan_ip.as_deref())
                        .await;
                (
                    RemoteAccessConfig {
                        addresses,
                        entry_address_id: stored.entry_address_id,
                    },
                    managed_lan_ip,
                )
            }
            None => {
                let lan_base_url = match inner.running.as_ref().and_then(|r| r.lan_base_url.clone())
                {
                    Some(url) => url,
                    None => {
                        let ip = match inner.last_lan_ip {
                            Some(ip) => ip,
                            None => {
                                let ip = lan_ip().await;
                                inner.last_lan_ip = Some(ip);
                                ip
                            }
                        };
                        format!("http://{ip}:{port}")
                    }
                };
                let before = access::default_config(
                    &lan_base_url,
                    &host.public_base_url,
                    &stored.entry_address_id,
                );
                let managed_lan_ip = direct_lan_host(&before.addresses, port)
                    .unwrap_or_default()
                    .to_owned();
                (before, managed_lan_ip)
            }
        };
        let managed_lan_ip =
            if direct_lan_host(&config.addresses, port) == Some(managed_lan_ip.as_str()) {
                managed_lan_ip
            } else {
                String::new()
            };
        let pairing = inner.running.as_ref().map(|r| r.pairing.clone());
        let origins = inner.running.as_ref().map(|r| r.origins.clone());
        tokio::task::spawn_blocking(move || {
            let changed = access::targets_changed(&before, &config);
            let scopes = pairing
                .as_ref()
                .and_then(|pairing| pairing.snapshot())
                .map_or(DEFAULT_PAIRING_SCOPES, |(_, info)| info.scopes);
            if changed && let Some(pairing) = &pairing {
                pairing.invalidate();
            }
            storage::set_remote_access_config(
                &storage::open_with_paths(&paths)?,
                &config,
                &managed_lan_ip,
            )?;
            if let Some(origins) = origins {
                origins.send_replace(config.addresses.clone());
            }
            if changed && let Some(pairing) = &pairing {
                pairing.regenerate(&paths, config.addresses, scopes)?;
            }
            Ok::<_, String>(())
        })
        .await
        .map_err(|_| "Remote WebUI address task failed".to_owned())??;
        drop(inner);
        self.snapshot(runtime).await
    }

    pub(crate) async fn set_entry_address(
        &self,
        runtime: &Runtime,
        entry_address_id: String,
    ) -> Result<RemoteHostState, String> {
        let _lifecycle = self.lifecycle.lock().await;
        let paths = runtime.paths.clone();
        let inner = self.inner.lock().await;
        let running = inner
            .running
            .as_ref()
            .ok_or("Remote WebUI is not running")?;
        let lan_base_url = running.lan_base_url.clone();
        tokio::task::spawn_blocking(move || {
            let db = storage::open_with_paths(&paths)?;
            let mut config = load_access_config(&db, lan_base_url.as_deref())?;
            config.entry_address_id = entry_address_id;
            let config = access::normalize_config(config)?;
            storage::set_remote_entry_address(&db, &config.entry_address_id)
        })
        .await
        .map_err(|_| "Remote WebUI address task failed".to_owned())??;
        drop(inner);
        self.snapshot(runtime).await
    }
}
