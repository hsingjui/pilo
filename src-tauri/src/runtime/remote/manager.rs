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
    domain::RemoteDevice,
    runtime::{host_paths::HostPaths, storage},
};

use super::{api, auth};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteHostState {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    pub base_url: Option<String>,
    pub pairing_url: Option<String>,
    pub pairing_expires_at_ms: Option<u64>,
    pub last_error: Option<String>,
    pub devices: Vec<RemoteDevice>,
}

#[derive(Clone, Debug)]
struct ActivePairing {
    secret: String,
    expires_at_ms: u64,
}

struct RunningRemoteServer {
    port: u16,
    base_url: String,
    pairing: Option<ActivePairing>,
    shutdown: watch::Sender<bool>,
    auth_generation: watch::Sender<u64>,
    task: JoinHandle<()>,
}

#[derive(Default)]
struct RemoteServerInner {
    running: Option<RunningRemoteServer>,
    last_error: Option<String>,
}

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
            storage::set_remote_host_config(&storage::open_with_paths(&paths)?, &config)?;
        } else {
            self.stop().await;
            config.enabled = false;
            storage::set_remote_host_config(&storage::open_with_paths(&paths)?, &config)?;
            let _ = storage::clear_remote_pairing(&storage::open_with_paths(&paths)?);
        }
        self.snapshot(&app).await
    }

    pub(crate) async fn regenerate_pairing(
        &self,
        app: &AppHandle,
    ) -> Result<RemoteHostState, String> {
        let paths = HostPaths::from_app(app)?;
        let pairing = auth::issue_pairing(&paths)?;
        let mut inner = self.inner.lock().await;
        let Some(running) = inner.running.as_mut() else {
            return Err("Remote WebUI is not running".to_owned());
        };
        running.pairing = Some(ActivePairing {
            secret: pairing.secret,
            expires_at_ms: pairing.expires_at_ms,
        });
        drop(inner);
        self.snapshot(app).await
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

    pub(crate) async fn snapshot(&self, app: &AppHandle) -> Result<RemoteHostState, String> {
        let paths = HostPaths::from_app(app)?;
        let db = storage::open_with_paths(&paths)?;
        let config = storage::get_remote_host_config(&db)?;
        let _ = storage::delete_expired_remote_devices(&db, storage::now_ms());
        let devices = storage::list_remote_devices(&db)?;
        let mut inner = self.inner.lock().await;

        if let Some(running) = inner.running.as_mut()
            && running
                .pairing
                .as_ref()
                .is_some_and(|pairing| pairing.expires_at_ms < storage::now_ms())
        {
            running.pairing = None;
        }

        let (running, port, base_url, pairing_url, pairing_expires_at_ms) =
            match inner.running.as_ref() {
                Some(server) => {
                    let pairing_url = server
                        .pairing
                        .as_ref()
                        .map(|pairing| format!("{}/?pair={}", server.base_url, pairing.secret));
                    (
                        true,
                        server.port,
                        Some(server.base_url.clone()),
                        pairing_url,
                        server.pairing.as_ref().map(|pairing| pairing.expires_at_ms),
                    )
                }
                None => (false, config.port, None, None, None),
            };

        Ok(RemoteHostState {
            enabled: config.enabled,
            running,
            port,
            base_url,
            pairing_url,
            pairing_expires_at_ms,
            last_error: inner.last_error.clone(),
            devices,
        })
    }

    pub(crate) async fn stop(&self) {
        let running = self.inner.lock().await.running.take();
        let Some(running) = running else {
            return;
        };
        let _ = running.shutdown.send(true);
        if tokio::time::timeout(Duration::from_secs(3), running.task)
            .await
            .is_err()
        {
            log::warn!(target: "remote-webui", "Remote WebUI shutdown timed out");
        }
    }

    async fn start(&self, app: AppHandle, port: u16) -> Result<(), String> {
        {
            let inner = self.inner.lock().await;
            if inner.running.is_some() {
                return Ok(());
            }
        }

        let bind_addr = SocketAddr::from(([0, 0, 0, 0], port));
        let listener = tokio::net::TcpListener::bind(bind_addr)
            .await
            .map_err(|error| format!("failed to bind Remote WebUI on port {port}: {error}"))?;
        let actual_port = listener
            .local_addr()
            .map_err(|error| format!("failed to read Remote WebUI listener address: {error}"))?
            .port();
        let base_url = format!("http://{}:{actual_port}", lan_ip());
        let paths = HostPaths::from_app(&app)?;
        let pairing = auth::issue_pairing(&paths)?;
        let active_pairing = ActivePairing {
            secret: pairing.secret,
            expires_at_ms: pairing.expires_at_ms,
        };
        let (shutdown, shutdown_rx) = watch::channel(false);
        let (auth_generation, auth_generation_rx) = watch::channel(0_u64);
        let shutdown_for_task = shutdown.clone();
        let router = api::router(app, paths, shutdown_rx, auth_generation_rx);
        let task = tokio::spawn(async move {
            let result = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async move {
                let mut shutdown_rx = shutdown_for_task.subscribe();
                if !*shutdown_rx.borrow() {
                    let _ = shutdown_rx.changed().await;
                }
            })
            .await;
            if let Err(error) = result {
                log::error!(target: "remote-webui", "Remote WebUI server stopped: {error}");
            }
        });

        let mut inner = self.inner.lock().await;
        inner.last_error = None;
        inner.running = Some(RunningRemoteServer {
            port: actual_port,
            base_url,
            pairing: Some(active_pairing),
            shutdown,
            auth_generation,
            task,
        });
        log::info!(target: "remote-webui", "Remote WebUI started on LAN port {actual_port}");
        Ok(())
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
