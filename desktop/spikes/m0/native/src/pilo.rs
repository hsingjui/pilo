//! The bridge to the Pilo runtime: `new Pilo()` in TSX is one host (data
//! directory, runtime, event bus) of the existing Rust runtime.

use std::{
    path::PathBuf,
    sync::{Arc, OnceLock},
    time::Instant,
};

use nsh_core::{JsonValue, prelude::*};
use pilo_lib::nsh_spike::SpikeHost;
use tokio::sync::{Mutex, mpsc};

/// Microseconds since the process's clock started: the one clock both
/// sides stamp with, so a delivery's latency is a difference of two reads.
fn now_us() -> f64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1e6
}

/// Where the Tauri app keeps its data: `app.hsingjui.pilo`, and
/// `app.hsingjui.pilo.dev` for a development build (`pnpm dev`).
fn default_data_dir() -> Result<PathBuf, String> {
    const IDENTIFIER: &str = if cfg!(debug_assertions) {
        "app.hsingjui.pilo.dev"
    } else {
        "app.hsingjui.pilo"
    };
    let var = |name: &str| std::env::var_os(name).map(PathBuf::from);
    let base = if cfg!(target_os = "macos") {
        var("HOME").map(|home| home.join("Library/Application Support"))
    } else if cfg!(target_os = "windows") {
        var("APPDATA")
    } else {
        var("XDG_DATA_HOME").or_else(|| var("HOME").map(|home| home.join(".local/share")))
    };
    base.map(|base| base.join(IDENTIFIER))
        .ok_or_else(|| "no home directory to find Pilo's data in".to_owned())
}

/// The `pilo-server` the workspace builds (`cargo build -p pilo-server`).
fn default_server_binary() -> PathBuf {
    let name = if cfg!(windows) {
        "pilo-server.exe"
    } else {
        "pilo-server"
    };
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/debug")
        .join(name)
}

type Events = Arc<Mutex<mpsc::UnboundedReceiver<JsonValue>>>;

/// A Pilo host: the existing runtime on the desktop app's data.
#[class]
pub struct Pilo {
    host: Arc<SpikeHost>,
    events: Events,
    /// The threads the Pilo runtime's work runs on. Its own: a constructor
    /// is a synchronous call from JS, outside the engine's tokio context,
    /// where `nsh_core::background` has no runtime to spawn on.
    runtime: Arc<tokio::runtime::Runtime>,
}

impl Pilo {
    /// Runs `work` of the host on the runtime's threads, for a task of the
    /// engine to await.
    async fn run<F, Fut, T>(this: &Instance<Self>, work: F) -> Result<T, String>
    where
        F: FnOnce(Arc<SpikeHost>) -> Fut,
        Fut: Future<Output = Result<T, String>> + Send + 'static,
        T: Send + 'static,
    {
        let task = this.with(|pilo| pilo.runtime.spawn(work(pilo.host.clone())));
        task.await.map_err(|error| error.to_string())?
    }
}

#[class]
impl Pilo {
    /// Opens the host on `dataDir` (the Tauri app's by default,
    /// `PILO_DATA_DIR` overriding it), running `serverBinary` (default:
    /// `PILO_SERVER_BINARY`, then the workspace's debug build) for Local
    /// connections.
    pub fn new(data_dir: Option<String>, server_binary: Option<String>) -> Result<Self, String> {
        let env = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
        let data_dir = match data_dir.or_else(|| env("PILO_DATA_DIR")) {
            Some(dir) => PathBuf::from(dir),
            None => default_data_dir()?,
        };
        let server_binary = server_binary
            .or_else(|| env("PILO_SERVER_BINARY"))
            .map_or_else(default_server_binary, PathBuf::from);
        let host = Arc::new(SpikeHost::open(data_dir, server_binary)?);

        // The bus is read on the runtime's threads; the engine thread takes
        // what queued up in one batch per `nextEvents()`.
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("pilo-runtime")
            .build()
            .map_err(|error| format!("failed to start the Pilo runtime: {error}"))?;
        let (sender, receiver) = mpsc::unbounded_channel();
        let mut events = host.events();
        runtime.spawn(async move {
            while let Some(mut event) = events.next().await {
                if let JsonValue::Object(fields) = &mut event {
                    fields.insert("rustUs".to_owned(), now_us().into());
                }
                if sender.send(event).is_err() {
                    break;
                }
            }
        });
        Ok(Pilo {
            host,
            events: Arc::new(Mutex::new(receiver)),
            runtime: Arc::new(runtime),
        })
    }

    /// The clock `rustUs` is read from, in microseconds.
    pub fn now_us() -> f64 {
        now_us()
    }

    /// The projects, as the frontend's `Project[]`.
    pub fn projects(&self) -> Result<JsonValue, String> {
        self.host.projects()
    }

    /// A project's indexed sessions, newest first (`SessionIndexEntry[]`).
    pub fn sessions(&self, project_id: String) -> Result<JsonValue, String> {
        self.host.sessions(&project_id)
    }

    /// Starts the chat `sessionKey` of a project (resuming `sessionPath`
    /// when given); resolves with its `PiSessionSnapshot`.
    pub async fn start_chat(
        this: Instance<Self>,
        project_id: String,
        session_key: String,
        session_path: Option<String>,
    ) -> Result<JsonValue, String> {
        Self::run(&this, |host| async move {
            host.start_chat(&project_id, &session_key, session_path)
                .await
        })
        .await
    }

    /// Sends `message` as a prompt to a started chat.
    pub async fn prompt(
        this: Instance<Self>,
        session_key: String,
        message: String,
    ) -> Result<(), String> {
        Self::run(&this, |host| async move {
            host.prompt(&session_key, &message).await
        })
        .await
    }

    /// Stops a chat's Pi process.
    pub async fn stop_chat(this: Instance<Self>, session_key: String) -> Result<(), String> {
        Self::run(
            &this,
            |host| async move { host.stop_chat(&session_key).await },
        )
        .await
    }

    /// Publishes a synthetic assistant message of `count` text deltas,
    /// `perSecond` a second, on the runtime's event bus.
    pub async fn emit_text_burst(
        this: Instance<Self>,
        session_key: String,
        project_id: String,
        count: u32,
        per_second: u32,
    ) -> Result<(), String> {
        Self::run(&this, |host| async move {
            host.emit_text_burst(&session_key, &project_id, count, per_second)
                .await;
            Ok(())
        })
        .await
    }

    /// The runtime events since the last call (at least one, waiting for
    /// it), each the frontend's `PiloRuntimeEvent` plus `rustUs`, when Rust
    /// read it from the bus. An empty array once the host is gone.
    pub async fn next_events(this: Instance<Self>) -> JsonValue {
        let events = this.with(|pilo| pilo.events.clone());
        let mut batch = Vec::new();
        events.lock().await.recv_many(&mut batch, 1024).await;
        JsonValue::Array(batch)
    }
}
