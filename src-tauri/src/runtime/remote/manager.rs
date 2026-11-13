use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket},
    sync::Arc,
    time::Duration,
};

use serde::Serialize;
use tauri::AppHandle;
use tokio::{
    sync::{Mutex, watch},
    task::JoinHandle,
};

use crate::{
    domain::{RemoteAccessAddress, RemoteAccessConfig, RemoteDevice},
    runtime::{host_paths::HostPaths, storage},
};

use super::{access, api, pairing::PairingSession};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteHostState {
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
    pub last_error: Option<String>,
    pub devices: Vec<RemoteDevice>,
}

struct RunningRemoteServer {
    port: u16,
    lan_base_url: String,
    pairing: Arc<PairingSession>,
    shutdown: watch::Sender<bool>,
    auth_generation: watch::Sender<u64>,
    task: JoinHandle<()>,
}

#[derive(Default)]
struct RemoteServerInner {
    running: Option<RunningRemoteServer>,
    last_error: Option<String>,
}

const MIN_REMOTE_PORT: u16 = 1024;

#[derive(Default)]
pub(crate) struct RemoteServerManager {
    inner: Arc<Mutex<RemoteServerInner>>,
}

impl RemoteServerManager {
    pub(crate) async fn restore(&self, app: AppHandle) -> Result<(), String> {
        let paths = HostPaths::from_app(&app)?;
        let config = storage::get_remote_host_config(&storage::open_with_paths(&paths)?)?;
        if !config.enabled {
            return Ok(());
        }
        if let Err(error) = self.start(app, config.port).await {
            self.inner.lock().await.last_error = Some(error.clone());
            return Err(error);
        }
        Ok(())
    }

    pub(crate) async fn set_enabled(
        &self,
        app: AppHandle,
        enabled: bool,
    ) -> Result<RemoteHostState, String> {
        let paths = HostPaths::from_app(&app)?;
        let mut config = storage::get_remote_host_config(&storage::open_with_paths(&paths)?)?;
        if enabled {
            self.start(app.clone(), config.port).await?;
            config.enabled = true;
        } else {
            self.stop().await;
            config.enabled = false;
            storage::clear_remote_pairing(&storage::open_with_paths(&paths)?)?;
        }
        storage::set_remote_host_config(&storage::open_with_paths(&paths)?, &config)?;
        self.snapshot(&app).await
    }

    pub(crate) async fn set_port(
        &self,
        app: AppHandle,
        port: u16,
    ) -> Result<RemoteHostState, String> {
        if port < MIN_REMOTE_PORT {
            return Err(format!(
                "Remote WebUI port must be between {MIN_REMOTE_PORT} and 65535"
            ));
        }
        let paths = HostPaths::from_app(&app)?;
        let mut config = storage::get_remote_host_config(&storage::open_with_paths(&paths)?)?;
        if config.port == port {
            return self.snapshot(&app).await;
        }
        let (was_running, lan_base_url) = {
            let inner = self.inner.lock().await;
            (
                inner.running.is_some(),
                inner.running.as_ref().map_or_else(
                    || format!("http://{}:{}", lan_ip(), config.port),
                    |running| running.lan_base_url.clone(),
                ),
            )
        };
        let paths_for_config = paths.clone();
        let previous_port = config.port;
        let access_config = tokio::task::spawn_blocking(move || {
            let db = storage::open_with_paths(&paths_for_config)?;
            let Some(mut config) = storage::get_remote_access_config(&db)? else {
                return Ok(None);
            };
            let mut changed = false;
            for address in &mut config.addresses {
                // Follow only untouched direct LAN URLs, never manually edited or proxy URLs.
                let previous_url = if address.id == "lan" {
                    Some(lan_base_url.clone())
                } else {
                    address
                        .id
                        .strip_prefix("lan-")
                        .and_then(|id| id.rsplit_once('-'))
                        .and_then(|(ip, _)| ip.replace('-', ".").parse::<Ipv4Addr>().ok())
                        .map(|ip| format!("http://{ip}:{previous_port}"))
                };
                if previous_url.as_deref() != Some(address.base_url.as_str()) {
                    continue;
                }
                let mut url = tauri::Url::parse(&address.base_url).map_err(|error| {
                    format!("failed to parse Remote WebUI LAN address: {error}")
                })?;
                url.set_port(Some(port))
                    .map_err(|_| "failed to update Remote WebUI LAN port".to_owned())?;
                address.base_url = url.origin().ascii_serialization();
                changed = true;
            }
            if changed {
                access::normalize_config(config).map(Some)
            } else {
                Ok(None)
            }
        })
        .await
        .map_err(|_| "Remote WebUI address task failed".to_owned())??;
        if was_running {
            self.stop().await;
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
            if let Some(access_config) = access_config {
                storage::set_remote_access_config(&transaction, &access_config)?;
            }
            transaction
                .commit()
                .map_err(|error| format!("failed to commit Remote WebUI port update: {error}"))
        })
        .await
        .map_err(|_| "Remote WebUI port task failed".to_owned())??;
        if was_running && let Err(error) = self.start(app.clone(), port).await {
            self.inner.lock().await.last_error = Some(error.clone());
            return Err(error);
        }
        self.snapshot(&app).await
    }

    pub(crate) async fn regenerate_pairing(
        &self,
        app: &AppHandle,
    ) -> Result<RemoteHostState, String> {
        let paths = HostPaths::from_app(app)?;
        let inner = self.inner.lock().await;
        let running = inner
            .running
            .as_ref()
            .ok_or("Remote WebUI is not running")?;
        let pairing = running.pairing.clone();
        let lan_base_url = running.lan_base_url.clone();
        tokio::task::spawn_blocking(move || {
            let config = load_access_config(&paths, &lan_base_url)?;
            pairing.regenerate(&paths, access::pairing_addresses(&config))
        })
        .await
        .map_err(|_| "Remote WebUI pairing task failed".to_owned())??;
        drop(inner);
        self.snapshot(app).await
    }

    pub(crate) async fn set_addresses(
        &self,
        app: AppHandle,
        config: RemoteAccessConfig,
    ) -> Result<RemoteHostState, String> {
        let config = access::normalize_config(config)?;
        let paths = HostPaths::from_app(&app)?;
        let inner = self.inner.lock().await;
        let lan_base_url = inner
            .running
            .as_ref()
            .map(|running| running.lan_base_url.clone());
        let pairing = inner
            .running
            .as_ref()
            .map(|running| running.pairing.clone());
        tokio::task::spawn_blocking(move || {
            let host = storage::get_remote_host_config(&storage::open_with_paths(&paths)?)?;
            let lan_base_url =
                lan_base_url.unwrap_or_else(|| format!("http://{}:{}", lan_ip(), host.port));
            let before = load_access_config(&paths, &lan_base_url)?;
            let changed = access::targets_changed(&before, &config);
            if changed && let Some(pairing) = &pairing {
                pairing.invalidate();
            }
            storage::set_remote_access_config(&storage::open_with_paths(&paths)?, &config)?;
            if changed && let Some(pairing) = &pairing {
                pairing.regenerate(&paths, config.addresses)?;
            }
            Ok::<_, String>(())
        })
        .await
        .map_err(|_| "Remote WebUI address task failed".to_owned())??;
        drop(inner);
        self.snapshot(&app).await
    }

    pub(crate) async fn set_public_base_url(
        &self,
        app: AppHandle,
        public_base_url: &str,
    ) -> Result<RemoteHostState, String> {
        let public_base_url = normalize_public_base_url(public_base_url)?;
        let state = self.snapshot(&app).await?;
        let mut addresses = state.addresses;
        addresses.retain(|address| address.id != "public");
        if !public_base_url.is_empty()
            && !addresses
                .iter()
                .any(|address| address.base_url == public_base_url)
        {
            addresses.push(RemoteAccessAddress {
                id: "public".to_owned(),
                name: String::new(),
                base_url: public_base_url,
            });
        }
        if addresses.is_empty() {
            addresses.push(RemoteAccessAddress {
                id: "lan".to_owned(),
                name: String::new(),
                base_url: format!("http://{}:{}", lan_ip(), state.port),
            });
        }
        let entry_address_id = addresses
            .iter()
            .find(|address| address.id == state.entry_address_id)
            .or_else(|| addresses.first())
            .ok_or("Remote WebUI needs an access address")?
            .id
            .clone();
        self.set_addresses(
            app,
            RemoteAccessConfig {
                addresses,
                entry_address_id,
            },
        )
        .await
    }

    pub(crate) async fn revoke_device(
        &self,
        app: &AppHandle,
        device_id: &str,
    ) -> Result<RemoteHostState, String> {
        let paths = HostPaths::from_app(app)?;
        let db = storage::open_with_paths(&paths)?;
        if !storage::revoke_remote_device(&db, device_id, storage::now_ms())? {
            return Err(format!(
                "Remote device '{device_id}' was not found or already revoked"
            ));
        }
        if let Some(running) = self.inner.lock().await.running.as_ref() {
            let next = running.auth_generation.borrow().wrapping_add(1);
            running.auth_generation.send_replace(next);
        }
        self.snapshot(app).await
    }

    pub(crate) async fn rename_device(
        &self,
        app: &AppHandle,
        device_id: &str,
        name: &str,
    ) -> Result<RemoteHostState, String> {
        let paths = HostPaths::from_app(app)?;
        let db = storage::open_with_paths(&paths)?;
        let name = super::auth::normalize_device_name(Some(name));
        if !storage::rename_remote_device(&db, device_id, &name)? {
            return Err(format!(
                "Remote device '{device_id}' was not found or already revoked"
            ));
        }
        self.snapshot(app).await
    }

    pub(crate) async fn snapshot(&self, app: &AppHandle) -> Result<RemoteHostState, String> {
        let paths = HostPaths::from_app(app)?;
        let inner = self.inner.lock().await;
        let running = inner.running.as_ref().map(|server| {
            (
                server.port,
                server.lan_base_url.clone(),
                server.pairing.clone(),
            )
        });
        let last_error = inner.last_error.clone();
        drop(inner);
        tokio::task::spawn_blocking(move || {
            let db = storage::open_with_paths(&paths)?;
            let host = storage::get_remote_host_config(&db)?;
            let _ = storage::delete_expired_remote_devices(&db, storage::now_ms());
            let devices = storage::list_remote_devices(&db)?;
            let lan_base_url = running.as_ref().map_or_else(
                || format!("http://{}:{}", lan_ip(), host.port),
                |(_, lan, _)| lan.clone(),
            );
            let config = load_access_config(&paths, &lan_base_url)?;
            let address_config_error = access::normalize_config(config.clone()).err();
            let pairing = running
                .as_ref()
                .and_then(|(_, _, pairing)| pairing.snapshot());
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
                .map(|_| effective_base_url(entry.as_deref().unwrap_or_default(), &lan_base_url));
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
                port: running.as_ref().map_or(host.port, |(port, _, _)| *port),
                base_url,
                public_base_url: host.public_base_url,
                pairing_expires_at_ms: pairing.as_ref().map(|(_, info)| info.expires_at_ms),
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
        })
        .await
        .map_err(|_| "Remote WebUI snapshot task failed".to_owned())?
    }

    pub(crate) async fn stop(&self) {
        let running = self.inner.lock().await.running.take();
        let Some(running) = running else {
            return;
        };
        let _ = running.shutdown.send(true);
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

    async fn start(&self, app: AppHandle, port: u16) -> Result<(), String> {
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
        let lan_base_url = format!("http://{}:{actual_port}", lan_ip());
        let paths = HostPaths::from_app(&app)?;
        let pairing = Arc::new(PairingSession::default());
        let pairing_for_init = pairing.clone();
        let paths_for_init = paths.clone();
        let lan_for_init = lan_base_url.clone();
        tokio::task::spawn_blocking(move || {
            let config = load_access_config(&paths_for_init, &lan_for_init)?;
            pairing_for_init.regenerate(&paths_for_init, access::pairing_addresses(&config))
        })
        .await
        .map_err(|_| "Remote WebUI pairing task failed".to_owned())??;
        let (shutdown, shutdown_rx) = watch::channel(false);
        let (auth_generation, auth_generation_rx) = watch::channel(0_u64);
        let shutdown_for_task = shutdown.clone();
        let router = api::router(app, paths, pairing.clone(), shutdown_rx, auth_generation_rx);
        let pairing_for_expiry = pairing.clone();
        let task = tokio::spawn(async move {
            let serve = async move {
                axum::serve(
                    listener,
                    router.into_make_service_with_connect_info::<SocketAddr>(),
                )
                .with_graceful_shutdown(async move {
                    let mut shutdown_rx = shutdown_for_task.subscribe();
                    if !*shutdown_rx.borrow() {
                        let _ = shutdown_rx.changed().await;
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
            task,
        });
        log::info!(target: "remote-webui", "Remote WebUI started on LAN port {actual_port}");
        Ok(())
    }
}

fn load_access_config(paths: &HostPaths, lan_base_url: &str) -> Result<RemoteAccessConfig, String> {
    let db = storage::open_with_paths(paths)?;
    let host = storage::get_remote_host_config(&db)?;
    Ok(storage::get_remote_access_config(&db)?
        .unwrap_or_else(|| access::default_config(lan_base_url, &host.public_base_url)))
}

fn trim_base_url(input: &str) -> &str {
    input.trim().trim_end_matches('/')
}

fn effective_base_url(public_base_url: &str, lan_base_url: &str) -> String {
    let configured = trim_base_url(public_base_url);
    if configured.is_empty() {
        lan_base_url.to_owned()
    } else {
        configured.to_owned()
    }
}

fn normalize_public_base_url(input: &str) -> Result<String, String> {
    let trimmed = trim_base_url(input);
    if trimmed.is_empty() {
        Ok(String::new())
    } else {
        access::normalize_base_url(trimmed)
    }
}

fn lan_ip() -> IpAddr {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0));
    let Ok(socket) = socket else {
        return IpAddr::V4(Ipv4Addr::LOCALHOST);
    };
    if socket.connect((Ipv4Addr::new(8, 8, 8, 8), 80)).is_ok()
        && let Ok(address) = socket.local_addr()
        && !address.ip().is_unspecified()
    {
        return address.ip();
    }
    IpAddr::V4(Ipv4Addr::LOCALHOST)
}

#[cfg(test)]
mod tests {
    use super::{effective_base_url, normalize_public_base_url};

    #[test]
    fn effective_base_url_prefers_configured_public_url() {
        assert_eq!(
            effective_base_url("https://dev.example.com", "http://192.168.1.5:47653"),
            "https://dev.example.com"
        );
        assert_eq!(
            effective_base_url("", "http://192.168.1.5:47653"),
            "http://192.168.1.5:47653"
        );
        assert_eq!(
            effective_base_url("  ", "http://192.168.1.5:47653"),
            "http://192.168.1.5:47653"
        );
    }

    #[test]
    fn normalize_public_base_url_validates_and_trims() {
        assert_eq!(normalize_public_base_url("  "), Ok(String::new()));
        assert_eq!(
            normalize_public_base_url("https://dev.example.com/"),
            Ok("https://dev.example.com".to_owned())
        );
        assert_eq!(
            normalize_public_base_url("http://dev.example.com:8080"),
            Ok("http://dev.example.com:8080".to_owned())
        );
        assert!(normalize_public_base_url("dev.example.com").is_err());
    }
}
