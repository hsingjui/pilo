//! Desktop-only transport for paired Hosts that require a proxy.

use std::{collections::BTreeMap, sync::Arc, time::Duration};

use futures_util::{SinkExt, StreamExt};
use nsh_core::prelude::*;
use reqwest::{Client, Method, Proxy, StatusCode, Url};
use reqwest_websocket::{Message, RequestBuilderExt};
use tokio::{
    sync::{Mutex, mpsc},
    task::{AbortHandle, JoinHandle},
};

use super::shell::executor;

const INVALID_URL: &str = "REMOTE_PROXY_INVALID_URL";
const NO_ROUTE: &str = "REMOTE_PROXY_NO_ROUTE";
const SYSTEM_FAILED: &str = "REMOTE_PROXY_SYSTEM_FAILED";
const AUTH_FAILED: &str = "REMOTE_PROXY_AUTH_FAILED";
const REQUEST_FAILED: &str = "REMOTE_PROXY_REQUEST_FAILED";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;

fn proxy_entry(host_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("app.pilo.remote-host-proxy", host_id)
        .map_err(|_| "REMOTE_PROXY_CREDENTIALS_FAILED".into())
}

fn parse_proxy_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|_| INVALID_URL)?;
    if !matches!(
        url.scheme(),
        "http" | "https" | "socks4" | "socks4a" | "socks5" | "socks5h"
    ) || url.host().is_none()
        || !matches!(url.path(), "" | "/")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(INVALID_URL.into());
    }
    Ok(url)
}

fn system_proxy(target: &Url) -> Result<Url, String> {
    use proxy_watch::{EnvPrecedence, Error, ProxyConfig, ProxyEnv, pac};

    let config = match proxy_watch::read() {
        Ok(config) => config,
        Err(Error::Unsupported) => ProxyConfig::direct(),
        Err(_) => return Err(SYSTEM_FAILED.into()),
    };
    let env = ProxyEnv::from_env().map_err(|_| SYSTEM_FAILED)?;
    let config = config.with_env(&env, EnvPrecedence::AfterSystem);
    let resolver = pac::PacResolver::new(pac::PacPolicy::new());
    #[cfg(any(windows, target_os = "macos"))]
    let resolver = resolver.with_native(
        pac::NativePacResolver::with_timeout(CONNECT_TIMEOUT)
            .map_err(|_| SYSTEM_FAILED)?
            .with_wpad(true),
    );
    let routes = resolver
        .resolve_config(&config, target, None)
        .map_err(|_| SYSTEM_FAILED)?;
    // A proxy-enabled Host must not silently send traffic directly.
    routes
        .first()
        .and_then(|route| route.to_url())
        .ok_or_else(|| NO_ROUTE.into())
}

async fn client_for(proxy_url: Option<String>, target: &Url) -> Result<Client, String> {
    let proxy_url = match proxy_url {
        Some(url) => parse_proxy_url(&url)?,
        None => {
            let target = target.clone();
            tokio::task::spawn_blocking(move || system_proxy(&target))
                .await
                .map_err(|_| SYSTEM_FAILED)??
        }
    };
    let proxy = Proxy::all(proxy_url).map_err(|_| INVALID_URL)?;
    Client::builder()
        .no_proxy()
        .proxy(proxy)
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(CONNECT_TIMEOUT)
        .http1_only()
        .build()
        .map_err(|_| REQUEST_FAILED.into())
}

fn target_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| REQUEST_FAILED)?;
    if url.host().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err(REQUEST_FAILED.into());
    }
    Ok(url)
}

/// Credential storage for custom remote-Host proxies.
#[module]
pub(crate) struct RemoteProxy;

#[module]
impl RemoteProxy {
    pub async fn saved_url(host_id: String) -> Result<Option<String>, String> {
        executor()?
            .spawn_blocking(move || match proxy_entry(&host_id)?.get_password() {
                Ok(url) => Ok(Some(url)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err("REMOTE_PROXY_CREDENTIALS_FAILED".into()),
            })
            .await
            .map_err(|_| "REMOTE_PROXY_CREDENTIALS_FAILED")?
    }

    pub async fn save_url(host_id: String, url: String) -> Result<(), String> {
        executor()?
            .spawn_blocking(move || {
                parse_proxy_url(&url)?;
                proxy_entry(&host_id)?
                    .set_password(&url)
                    .map_err(|_| "REMOTE_PROXY_CREDENTIALS_FAILED".into())
            })
            .await
            .map_err(|_| "REMOTE_PROXY_CREDENTIALS_FAILED")?
    }

    pub async fn delete_url(host_id: String) -> Result<(), String> {
        executor()?
            .spawn_blocking(move || match proxy_entry(&host_id)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err("REMOTE_PROXY_CREDENTIALS_FAILED".into()),
            })
            .await
            .map_err(|_| "REMOTE_PROXY_CREDENTIALS_FAILED")?
    }
}

#[derive(JsObject)]
pub struct RemoteProxyResponse {
    pub status: u32,
    pub body: Vec<u8>,
}

/// One HTTP request, cancellable when the Host transport is disposed or times out.
#[class]
pub(crate) struct RemoteProxyRequest {
    task: Option<JoinHandle<Result<RemoteProxyResponse, String>>>,
    abort: AbortHandle,
}

#[class]
impl RemoteProxyRequest {
    pub fn new(
        proxy_url: Option<String>,
        url: String,
        method: String,
        headers: BTreeMap<String, String>,
        body: Option<Vec<u8>>,
    ) -> Result<Self, String> {
        let target = target_url(&url)?;
        if !matches!(target.scheme(), "http" | "https") {
            return Err(REQUEST_FAILED.into());
        }
        let method = Method::from_bytes(method.as_bytes()).map_err(|_| REQUEST_FAILED)?;
        let task = executor()?.spawn(async move {
            let client = client_for(proxy_url, &target).await?;
            let mut request = client.request(method, target);
            for (name, value) in headers {
                request = request.header(name, value);
            }
            if let Some(body) = body {
                request = request.body(body);
            }
            let mut response = request.send().await.map_err(|_| REQUEST_FAILED)?;
            let status = response.status();
            if status == StatusCode::PROXY_AUTHENTICATION_REQUIRED {
                return Err(AUTH_FAILED.into());
            }
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| REQUEST_FAILED)? {
                if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
                    return Err(REQUEST_FAILED.into());
                }
                body.extend_from_slice(&chunk);
            }
            Ok(RemoteProxyResponse {
                status: status.as_u16().into(),
                body,
            })
        });
        let abort = task.abort_handle();
        Ok(Self {
            task: Some(task),
            abort,
        })
    }

    pub async fn response(this: Instance<Self>) -> Result<RemoteProxyResponse, String> {
        let task = this
            .with_mut(|request| request.task.take())
            .ok_or(REQUEST_FAILED)?;
        task.await.map_err(|_| REQUEST_FAILED)?
    }

    pub fn abort(&self) {
        self.abort.abort();
    }
}

impl Drop for RemoteProxyRequest {
    fn drop(&mut self) {
        self.abort.abort();
    }
}

#[derive(JsObject)]
pub struct RemoteProxySocketEvent {
    // The first event opens the socket; subsequent events contain text frames.
    pub text: Option<String>,
}

/// Remote Host event socket using the same proxy routing as HTTP requests.
#[class]
pub(crate) struct RemoteProxySocket {
    commands: mpsc::Sender<String>,
    events: Arc<Mutex<mpsc::Receiver<RemoteProxySocketEvent>>>,
    task: JoinHandle<()>,
}

#[class]
impl RemoteProxySocket {
    pub fn new(
        proxy_url: Option<String>,
        url: String,
        protocols: Vec<String>,
    ) -> Result<Self, String> {
        let mut target = target_url(&url)?;
        let scheme = match target.scheme() {
            "ws" => "http",
            "wss" => "https",
            _ => return Err(REQUEST_FAILED.into()),
        };
        target.set_scheme(scheme).map_err(|_| REQUEST_FAILED)?;
        let (commands, mut incoming) = mpsc::channel::<String>(8);
        let (outgoing, events) = mpsc::channel(1);
        let task = executor()?.spawn(async move {
            let connect = async {
                let client = client_for(proxy_url, &target).await?;
                let response = client.get(target).upgrade().protocols(protocols).send().await
                    .map_err(|_| REQUEST_FAILED)?;
                response.into_websocket().await.map_err(|_| REQUEST_FAILED.to_owned())
            };
            let Ok(Ok(mut socket)) = tokio::time::timeout(CONNECT_TIMEOUT, connect).await else {
                return;
            };
            if outgoing.send(RemoteProxySocketEvent { text: None }).await.is_err() {
                return;
            }
            loop {
                tokio::select! {
                    command = incoming.recv() => {
                        let Some(text) = command else { return; };
                        if socket.send(Message::Text(text)).await.is_err() { return; }
                    }
                    message = socket.next() => match message {
                        Some(Ok(Message::Text(text))) => {
                            if outgoing.send(RemoteProxySocketEvent { text: Some(text) }).await.is_err() {
                                return;
                            }
                        }
                        Some(Ok(Message::Ping(_))) => {
                            if socket.flush().await.is_err() { return; }
                        }
                        Some(Ok(Message::Close { .. })) | Some(Err(_)) | None => return,
                        Some(Ok(_)) => {}
                    }
                }
            }
        });
        Ok(Self {
            commands,
            events: Arc::new(Mutex::new(events)),
            task,
        })
    }

    pub async fn next_event(this: Instance<Self>) -> Option<RemoteProxySocketEvent> {
        let events = this.with(|socket| Arc::clone(&socket.events));
        events.lock().await.recv().await
    }

    pub fn send(&self, text: String) -> Result<(), String> {
        self.commands
            .try_send(text)
            .map_err(|_| REQUEST_FAILED.into())
    }

    pub fn close(&self) {
        self.task.abort();
    }
}

impl Drop for RemoteProxySocket {
    fn drop(&mut self) {
        self.task.abort();
    }
}
