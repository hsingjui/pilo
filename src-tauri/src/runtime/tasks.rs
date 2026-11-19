use std::{future::Future, sync::OnceLock};

use tokio::runtime::Handle;

static HOST_RUNTIME: Scheduler = Scheduler(OnceLock::new());
static FALLBACK_RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

struct Scheduler(OnceLock<Handle>);

impl Scheduler {
    fn initialize(&self, handle: Handle) {
        let _ = self.0.set(handle);
    }

    fn handle(&self) -> Handle {
        Handle::try_current()
            .ok()
            .or_else(|| self.0.get().cloned())
            .unwrap_or_else(|| {
                FALLBACK_RUNTIME
                    .get_or_init(|| {
                        tokio::runtime::Builder::new_multi_thread()
                            .enable_all()
                            .thread_name("pilo-runtime")
                            .build()
                            .expect("failed to create Pilo background runtime")
                    })
                    .handle()
                    .clone()
            })
    }
}

pub fn initialize(handle: Handle) {
    HOST_RUNTIME.initialize(handle);
}

fn handle() -> Handle {
    HOST_RUNTIME.handle()
}

pub(crate) fn spawn<F>(future: F)
where
    F: Future<Output = ()> + Send + 'static,
{
    handle().spawn(future);
}

pub(crate) fn spawn_blocking<F>(function: F)
where
    F: FnOnce() + Send + 'static,
{
    handle().spawn_blocking(function);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injected_runtime_schedules_without_a_current_runtime() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let scheduler = Scheduler(OnceLock::new());
        scheduler.initialize(runtime.handle().clone());
        assert!(Handle::try_current().is_err());
        assert_eq!(scheduler.handle().id(), runtime.handle().id());
        let (send, receive) = std::sync::mpsc::channel();
        let blocking_send = send.clone();
        scheduler.handle().spawn(async move {
            send.send(Handle::current().id()).unwrap();
        });
        scheduler.handle().spawn_blocking(move || {
            blocking_send.send(Handle::current().id()).unwrap();
        });
        for _ in 0..2 {
            assert_eq!(
                receive
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap(),
                runtime.handle().id()
            );
        }
    }

    #[test]
    fn synchronous_callback_schedules_without_initialization() {
        assert!(tokio::runtime::Handle::try_current().is_err());
        assert_eq!(handle().id(), FALLBACK_RUNTIME.get().unwrap().handle().id());
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
        assert_eq!(super::handle().id(), tokio::runtime::Handle::current().id());
        let (send, receive) = tokio::sync::oneshot::channel();
        super::spawn(async move {
            let _ = send.send(());
        });
        receive.await.unwrap();
    }

    #[test]
    fn current_runtime_takes_priority_over_injected_handle() {
        let injected = tokio::runtime::Runtime::new().unwrap();
        let current = tokio::runtime::Runtime::new().unwrap();
        let scheduler = Scheduler(OnceLock::new());
        scheduler.initialize(injected.handle().clone());
        current.block_on(async {
            assert_eq!(scheduler.handle().id(), current.handle().id());
            let (send, receive) = tokio::sync::oneshot::channel();
            scheduler.handle().spawn(async move {
                let _ = send.send(Handle::current().id());
            });
            assert_eq!(receive.await.unwrap(), current.handle().id());
        });
    }

    #[test]
    fn synchronous_scheduling_survives_an_unrelated_runtime_being_dropped() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let (send, receive) = tokio::sync::oneshot::channel();
            super::spawn(async move {
                let _ = send.send(());
            });
            receive.await.unwrap();
        });
        drop(runtime);
        synchronous_callback_schedules_without_initialization();
    }
}
