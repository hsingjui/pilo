pub mod commands;
mod events;
mod local;
mod pi_events;
mod pi_session;
mod process;
mod rpc;

use tokio::sync::Mutex;

use pi_session::PiSession;

pub struct PiloRuntime {
    pub(crate) pi_session: Mutex<PiSession>,
}

impl Default for PiloRuntime {
    fn default() -> Self {
        Self {
            pi_session: Mutex::new(PiSession::default()),
        }
    }
}
