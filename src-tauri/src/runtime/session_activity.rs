use serde::{Deserialize, Serialize};

use crate::domain::Project;

use super::{PiloRuntime, events::PiProcessState, server_client::ServerClient};

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionExternalActivity {
    pub path: String,
    pub turn_open: bool,
}

pub(crate) async fn external_session_activities_for_project(
    runtime: &PiloRuntime,
    project: &Project,
    cached_client: Option<&ServerClient>,
) -> Result<Vec<SessionExternalActivity>, String> {
    if project.default_workspace_pending() {
        return Ok(Vec::new());
    }
    let owned_session_paths = runtime
        .chat_sessions
        .states()
        .await
        .into_iter()
        .filter(|state| state.project_id == project.id)
        .filter(|state| {
            matches!(
                state.snapshot.state,
                PiProcessState::Running | PiProcessState::Starting
            )
        })
        .filter_map(|state| state.session_path)
        .collect::<Vec<_>>();
    let params = serde_json::json!({
        "project": project.path,
        "ownedSessionPaths": owned_session_paths,
    });
    if let Some(client) = cached_client {
        let value = client.request("session.activity", params).await?;
        return serde_json::from_value(value).map_err(|error| {
            format!("invalid pilo-server response for session.activity: {error}")
        });
    }
    runtime
        .servers
        .request_typed(&project.connection, "session.activity", params)
        .await
}

fn session_has_external_open_turn(
    activities: &[SessionExternalActivity],
    session_path: &str,
) -> bool {
    activities
        .iter()
        .any(|activity| activity.turn_open && activity.path == session_path)
}

pub(crate) async fn reject_external_session_owner(
    runtime: &PiloRuntime,
    project: &Project,
    session_path: Option<&str>,
) -> Result<(), String> {
    let Some(session_path) = session_path else {
        return Ok(());
    };
    let activities = external_session_activities_for_project(runtime, project, None).await?;
    if session_has_external_open_turn(&activities, session_path) {
        return Err(
            "session is currently owned by an external Pi process; Pilo opened it in read-only observer mode"
                .to_owned(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{SessionExternalActivity, session_has_external_open_turn};

    #[test]
    fn only_open_external_turns_block_session_ownership() {
        let activities = vec![
            SessionExternalActivity {
                path: "/tmp/idle.jsonl".to_owned(),
                turn_open: false,
            },
            SessionExternalActivity {
                path: "/tmp/running.jsonl".to_owned(),
                turn_open: true,
            },
        ];

        assert!(!session_has_external_open_turn(
            &activities,
            "/tmp/idle.jsonl"
        ));
        assert!(session_has_external_open_turn(
            &activities,
            "/tmp/running.jsonl"
        ));
        assert!(!session_has_external_open_turn(
            &activities,
            "/tmp/unknown.jsonl"
        ));
    }
}
