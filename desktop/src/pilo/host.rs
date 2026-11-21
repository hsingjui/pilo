//! The shared runtime handle: admission of operations and shutdown.

use std::{future::Future, sync::Arc};

use pilo_runtime::Runtime;
use tokio::sync::Mutex;

pub(super) const CLOSED: &str = "Pilo runtime has been shut down";

pub(super) type Host = Arc<Mutex<Option<Runtime>>>;

pub(super) async fn stop_host(host: Host) {
    let mut host = host.lock().await;
    if let Some(runtime) = host.take() {
        runtime.shutdown().await;
    }
}

pub(super) async fn run_with_runtime<T, F>(
    host: Host,
    operation: impl FnOnce(Runtime) -> F,
) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    let runtime = host.lock().await.as_ref().ok_or(CLOSED)?.clone();
    operation(runtime).await
}
