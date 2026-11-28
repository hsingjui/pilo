use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use pilo_domain::{RemoteAccessAddress, RemoteAccessConfig, RemoteDevice, RemoteScopes};
use serde::Serialize;
use tokio::{
    sync::{Mutex, watch},
    task::JoinHandle,
};

use crate::{Runtime, RuntimeEventBus, storage};

use super::{access, api, pairing::PairingSession};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHostState {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    pub base_url: Option<String>,
    pub public_base_url: String,
    pub addresses: Vec<RemoteAccessAddress>,
    pub entry_address_id: String,
    pub address_config_error: Option<String>,
    pub pairing_url: Option<String>,
    pub pairing_expires_at_ms: Option<u64>,
    pub pairing_remaining_uses: usize,
    pub pairing_total_uses: usize,
    pub pairing_scopes: Option<RemoteScopes>,
    pub last_error: Option<String>,
    pub devices: Vec<RemoteDevice>,
}

struct RunningRemoteServer {
    port: u16,
    lan_base_url: Option<String>,
    pairing: Arc<PairingSession>,
    shutdown: watch::Sender<bool>,
    auth_generation: watch::Sender<u64>,
    origins: watch::Sender<Vec<RemoteAccessAddress>>,
    events: RuntimeEventBus,
    task: JoinHandle<()>,
}

#[derive(Default)]
struct RemoteServerInner {
    running: Option<RunningRemoteServer>,
    last_error: Option<String>,
    last_lan_ip: Option<IpAddr>,
}

const MIN_REMOTE_PORT: u16 = 1024;
const DEFAULT_PAIRING_SCOPES: RemoteScopes = RemoteScopes::ChatWorkspace;

fn next_auth_generation() -> u64 {
    // The auth cache outlives listeners, so starts and revocations share one sequence.
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

#[derive(Clone, Default)]
pub(crate) struct RemoteServerManager {
    lifecycle: Arc<Mutex<()>>,
    inner: Arc<Mutex<RemoteServerInner>>,
}

mod access_settings;
use access_settings::{
    direct_lan_host, effective_base_url, lan_ip, read_host_access, resolve_managed_lan_ip,
};
mod device_admin;
mod pairing_admin;

#[cfg(test)]
mod tests;

impl RemoteServerManager {
    pub(crate) async fn restore(&self, runtime: &Runtime) -> Result<(), String> {
        let _lifecycle = self.lifecycle.lock().await;
        if runtime.servers.is_shutting_down() {
            return Ok(());
        }
        let paths = runtime.paths.clone();
        let config = storage::get_remote_host_config(&storage::open_with_paths(&paths)?)?;
        if !config.enabled {
            return Ok(());
        }
        if let Err(error) = self.start(runtime, config.port).await {
            self.inner.lock().await.last_error = Some(error.clone());
            return Err(error);
        }
        Ok(())
    }

    pub(crate) async fn set_enabled(
        &self,
        runtime: &Runtime,
        enabled: bool,
    ) -> Result<RemoteHostState, String> {
        let _lifecycle = self.lifecycle.lock().await;
        let paths = runtime.paths.clone();
        let mut config = storage::get_remote_host_config(&storage::open_with_paths(&paths)?)?;
        if enabled {
            self.start(runtime, config.port).await?;
            config.enabled = true;
        } else {
            self.stop_listener().await;
            runtime.terminals.close_all_remote().await;
            config.enabled = false;
            storage::clear_remote_pairing(&storage::open_with_paths(&paths)?)?;
        }
        storage::set_remote_host_config(&storage::open_with_paths(&paths)?, &config)?;
        self.snapshot(runtime).await
    }

    pub(crate) async fn set_port(
        &self,
        runtime: &Runtime,
        port: u16,
    ) -> Result<RemoteHostState, String> {
        if port < MIN_REMOTE_PORT {
            return Err(format!(
                "Remote WebUI port must be between {MIN_REMOTE_PORT} and 65535"
            ));
        }
        let _lifecycle = self.lifecycle.lock().await;
        let paths = runtime.paths.clone();
        let (mut config, stored) = read_host_access(&paths).await?;
        if config.port == port {
            return self.snapshot(runtime).await;
        }
        let was_running = self.inner.lock().await.running.is_some();
        let access_config = if let Some(mut addresses) = stored.addresses {
            let managed_lan_ip =
                resolve_managed_lan_ip(&addresses, config.port, stored.managed_lan_ip.as_deref())
                    .await;
            let mut changed = false;
            for address in &mut addresses {
                // Follow only untouched direct LAN URLs, never manually edited or proxy URLs.
                let ip = if address.id == "lan" {
                    managed_lan_ip.parse::<Ipv4Addr>().ok()
                } else {
                    address
                        .id
                        .strip_prefix("lan-")
                        .and_then(|id| id.rsplit_once('-'))
                        .and_then(|(ip, _)| ip.replace('-', ".").parse::<Ipv4Addr>().ok())
                };
                if let Some(ip) = ip
                    && address.base_url == format!("http://{ip}:{}", config.port)
                {
                    address.base_url = format!("http://{ip}:{port}");
                    changed = true;
                }
            }
            if changed {
                let updated = access::normalize_config(RemoteAccessConfig {
                    addresses,
                    entry_address_id: stored.entry_address_id,
                })?;
                Some((updated, managed_lan_ip))
            } else {
                None
            }
        } else {
            None
        };
        if was_running {
            self.stop_listener().await;
            runtime.terminals.close_all_remote().await;
        }
        config.port = port;
        tokio::task::spawn_blocking(move || {
            let mut db = storage::open_with_paths(&paths)?;
            let transaction = db
                .transaction()
                .map_err(|error| format!("failed to begin Remote WebUI port update: {error}"))?;
            // Preserve the existing port-change policy; address edits do not take this path.
            storage::clear_remote_devices(&transaction)?;
            storage::set_remote_host_config(&transaction, &config)?;
            if let Some((access_config, managed_lan_ip)) = access_config {
                storage::set_remote_access_config(&transaction, &access_config, &managed_lan_ip)?;
            }
            transaction
                .commit()
                .map_err(|error| format!("failed to commit Remote WebUI port update: {error}"))
        })
        .await
        .map_err(|_| "Remote WebUI port task failed".to_owned())??;
        if was_running && let Err(error) = self.start(runtime, port).await {
            self.inner.lock().await.last_error = Some(error.clone());
            return Err(error);
        }
        self.snapshot(runtime).await
    }

    pub(crate) async fn snapshot(&self, runtime: &Runtime) -> Result<RemoteHostState, String> {
        let paths = runtime.paths.clone();
        let inner = self.inner.lock().await;
        let running = inner
            .running
            .as_ref()
            .map(|server| (server.port, server.lan_base_url.clone()));
        let pairing = inner.running.as_ref().map(|server| server.pairing.clone());
        let last_error = inner.last_error.clone();
        let last_lan_ip = inner.last_lan_ip;
        drop(inner);
        let (host, devices, config, pairing) = tokio::task::spawn_blocking(move || {
            let db = storage::open_with_paths(&paths)?;
            let host = storage::get_remote_host_config(&db)?;
            let _ = storage::delete_expired_remote_devices(&db, storage::now_ms());
            let devices = storage::list_remote_devices(&db)?;
            let config = storage::get_remote_access_config(&db)?;
            let pairing = pairing.and_then(|pairing| pairing.snapshot());
            Ok::<_, String>((host, devices, config, pairing))
        })
        .await
        .map_err(|_| "Remote WebUI snapshot task failed".to_owned())??;
        let port = running.as_ref().map_or(host.port, |(port, _)| *port);
        let config = match config.addresses {
            Some(addresses) => RemoteAccessConfig {
                addresses,
                entry_address_id: config.entry_address_id,
            },
            None => {
                let lan_base_url = match running.as_ref().and_then(|(_, url)| url.as_ref()) {
                    Some(url) => url.clone(),
                    None => {
                        let ip = match last_lan_ip {
                            Some(ip) => ip,
                            None => {
                                let detected = lan_ip().await;
                                *self.inner.lock().await.last_lan_ip.get_or_insert(detected)
                            }
                        };
                        format!("http://{ip}:{port}")
                    }
                };
                access::default_config(
                    &lan_base_url,
                    &host.public_base_url,
                    &config.entry_address_id,
                )
            }
        };
        let address_config_error = access::normalize_config(config.clone()).err();
        // Resolve a secret's URL against its own snapshot, never against a concurrently edited URL.
        let entry = pairing
            .as_ref()
            .and_then(|(_, info)| {
                info.addresses
                    .iter()
                    .find(|address| address.address.id == config.entry_address_id)
                    .or_else(|| info.addresses.first())
                    .map(|address| address.address.base_url.clone())
            })
            .or_else(|| {
                config
                    .addresses
                    .iter()
                    .find(|address| address.id == config.entry_address_id)
                    .and_then(|address| access::normalize_base_url(&address.base_url).ok())
            });
        let base_url = running
            .as_ref()
            .and_then(|(_, lan_base_url)| match lan_base_url {
                Some(lan_base_url) => Some(effective_base_url(
                    entry.as_deref().unwrap_or_default(),
                    lan_base_url,
                )),
                None => entry,
            });
        let pairing_url = pairing
            .as_ref()
            .filter(|(_, info)| info.remaining_uses > 0)
            .and_then(|(secret, _)| {
                base_url
                    .as_ref()
                    .map(|base| format!("{base}/pair#pair={secret}"))
            });
        Ok(RemoteHostState {
            enabled: host.enabled,
            running: running.is_some(),
            port,
            base_url,
            public_base_url: host.public_base_url,
            pairing_expires_at_ms: pairing.as_ref().map(|(_, info)| info.expires_at_ms),
            pairing_scopes: pairing.as_ref().map(|(_, info)| info.scopes),
            pairing_remaining_uses: pairing.as_ref().map_or(0, |(_, info)| info.remaining_uses),
            pairing_total_uses: pairing.as_ref().map_or_else(
                || access::pairing_addresses(&config).len(),
                |(_, info)| info.addresses.len(),
            ),
            pairing_url,
            addresses: config.addresses,
            entry_address_id: config.entry_address_id,
            address_config_error,
            last_error,
            devices,
        })
    }

    pub(crate) async fn stop(&self) {
        let _lifecycle = self.lifecycle.lock().await;
        self.stop_listener().await;
    }

    async fn stop_listener(&self) {
        let running = {
            let mut inner = self.inner.lock().await;
            let Some(running) = inner.running.take() else {
                return;
            };
            let _ = running.shutdown.send(true);
            running.events.set_web_events_enabled(false);
            running
        };
        let pairing = running.pairing;
        let _ = tokio::task::spawn_blocking(move || pairing.invalidate()).await;
        let mut task = running.task;
        if tokio::time::timeout(Duration::from_secs(3), &mut task)
            .await
            .is_err()
        {
            log::warn!(target: "remote-webui", "Remote WebUI shutdown timed out; aborting server task");
            task.abort();
            let _ = task.await;
        }
    }

    async fn start(&self, runtime: &Runtime, port: u16) -> Result<(), String> {
        let mut inner = self.inner.lock().await;
        if inner.running.is_some() {
            return Ok(());
        }
        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], port)))
            .await
            .map_err(|error| format!("failed to bind Remote WebUI on port {port}: {error}"))?;
        let actual_port = listener
            .local_addr()
            .map_err(|error| format!("failed to read Remote WebUI listener address: {error}"))?
            .port();
        let paths = runtime.paths.clone();
        let (host, stored) = read_host_access(&paths).await?;
        let (config, lan_base_url) = match stored.addresses {
            Some(addresses) => {
                // Classify a legacy direct LAN address once, while its startup IP is known.
                if stored.managed_lan_ip.is_none()
                    && direct_lan_host(&addresses, actual_port).is_some()
                {
                    let ip = resolve_managed_lan_ip(&addresses, actual_port, None).await;
                    // A mismatch can mean the original interface is temporarily down.
                    if !ip.is_empty() {
                        let paths = paths.clone();
                        tokio::task::spawn_blocking(move || {
                            storage::set_remote_managed_lan_ip(
                                &storage::open_with_paths(&paths)?,
                                &ip,
                            )
                        })
                        .await
                        .map_err(|_| "Remote WebUI address task failed".to_owned())??;
                    }
                }
                (
                    RemoteAccessConfig {
                        addresses,
                        entry_address_id: stored.entry_address_id,
                    },
                    None,
                )
            }
            None => {
                let ip = lan_ip().await;
                let url = format!("http://{ip}:{actual_port}");
                inner.last_lan_ip = Some(ip);
                (
                    access::default_config(&url, &host.public_base_url, &stored.entry_address_id),
                    Some(url),
                )
            }
        };
        let pairing = Arc::new(PairingSession::default());
        let pairing_for_init = pairing.clone();
        let addresses = tokio::task::spawn_blocking(move || {
            let addresses = access::pairing_addresses(&config);
            pairing_for_init.regenerate(&paths, addresses.clone(), DEFAULT_PAIRING_SCOPES)?;
            Ok::<_, String>(addresses)
        })
        .await
        .map_err(|_| "Remote WebUI pairing task failed".to_owned())??;
        if runtime.servers.is_shutting_down() {
            return Err("Remote WebUI cannot start while Pilo is shutting down".to_owned());
        }
        let (shutdown, shutdown_rx) = watch::channel(false);
        let (auth_generation, auth_generation_rx) = watch::channel(next_auth_generation());
        let (origins, origins_rx) = watch::channel(addresses);
        let mut shutdown_for_task = shutdown.subscribe();
        let events = runtime.events.clone();
        events.set_web_events_enabled(true);
        let router = api::router(
            runtime.clone(),
            pairing.clone(),
            shutdown_rx,
            auth_generation_rx,
            origins_rx,
        );
        let pairing_for_expiry = pairing.clone();
        let task = tokio::spawn(async move {
            let serve = async move {
                axum::serve(
                    listener,
                    router.into_make_service_with_connect_info::<SocketAddr>(),
                )
                .with_graceful_shutdown(async move {
                    if !*shutdown_for_task.borrow() {
                        let _ = shutdown_for_task.changed().await;
                    }
                })
                .await
            };
            let expire = async move {
                let mut expiry_tick = tokio::time::interval(Duration::from_secs(15));
                loop {
                    expiry_tick.tick().await;
                    let pairing = pairing_for_expiry.clone();
                    let _ = tokio::task::spawn_blocking(move || pairing.expire()).await;
                }
            };
            // Keep serving while cleanup waits for the batch lock; neither future outlives this task.
            tokio::select! {
                result = serve => {
                    if let Err(error) = result {
                        log::error!(target: "remote-webui", "Remote WebUI server stopped: {error}");
                    }
                }
                _ = expire => {}
            }
        });
        inner.last_error = None;
        inner.running = Some(RunningRemoteServer {
            port: actual_port,
            lan_base_url,
            pairing,
            shutdown,
            auth_generation,
            origins,
            events,
            task,
        });
        log::info!(target: "remote-webui", "Remote WebUI started on LAN port {actual_port}");
        Ok(())
    }
}
