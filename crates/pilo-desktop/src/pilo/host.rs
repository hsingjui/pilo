//! The shared runtime handle: admission of operations and shutdown.

use std::{future::Future, sync::Arc};

use pilo_runtime::{
    Runtime,
    host_api::{self, Principal},
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::sync::Mutex;

pub(super) const CLOSED: &str = "Pilo runtime has been shut down";

pub(super) type Host = Arc<Mutex<Option<Runtime>>>;

pub(super) async fn stop_host(host: Host) {
    let mut host = host.lock().await;
    if let Some(runtime) = host.take()
        && let Err(error) = call_local::<()>(&runtime, "host.shutdown", json!({})).await
    {
        log::warn!(target: "shutdown", "Host shutdown failed: {error}");
    }
}

pub(super) async fn call_local<T: DeserializeOwned>(
    runtime: &Runtime,
    method: &str,
    params: Value,
) -> Result<T, String> {
    let value = host_api::call(runtime, &Principal::Local, method, params)
        .await
        .map_err(|err| err.message)?;
    decode_host_response(value)
}

pub(super) fn decode_host_response<T: DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|err| err.to_string())
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
