use std::{future::Future, sync::OnceLock};

use tokio::runtime::Handle;

static HOST_RUNTIME: OnceLock<Handle> = OnceLock::new();

pub fn initialize(handle: Handle) {
    let _ = HOST_RUNTIME.set(handle);
}

pub(crate) fn spawn<F>(future: F)
where
    F: Future<Output = ()> + Send + 'static,
{
    let handle = Handle::try_current()
        .ok()
        .or_else(|| HOST_RUNTIME.get().cloned());
    if let Some(handle) = handle {
        handle.spawn(future);
    } else {
        log::error!(target: "runtime", "cannot schedule task before host runtime initialization");
    }
}

pub(crate) fn spawn_blocking<F>(function: F)
where
    F: FnOnce() + Send + 'static,
{
    let handle = Handle::try_current()
        .ok()
        .or_else(|| HOST_RUNTIME.get().cloned());
    if let Some(handle) = handle {
        handle.spawn_blocking(function);
    } else {
        log::error!(target: "runtime", "cannot schedule blocking task before host runtime initialization");
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn host_handle_schedules_from_synchronous_callback() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        super::initialize(runtime.handle().clone());
        let (send, receive) = std::sync::mpsc::channel();
        super::spawn(async move {
            send.send(()).unwrap();
        });
        receive
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        super::spawn_blocking(move || {
            send.send(()).unwrap();
        });
        receive
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
    }

    #[tokio::test]
    async fn current_runtime_schedules_without_host_initialization() {
        let (send, receive) = tokio::sync::oneshot::channel();
        super::spawn(async move {
            let _ = send.send(());
        });
        receive.await.unwrap();
    }
}
