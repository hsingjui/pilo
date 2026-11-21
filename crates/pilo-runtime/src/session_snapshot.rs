use serde::Serialize;

use pilo_domain::Connection;

use super::events::PiProcessState;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiSessionSnapshot {
    pub generation: u64,
    pub state: PiProcessState,
    pub connection: Option<Connection>,
    pub project_id: Option<String>,
}
