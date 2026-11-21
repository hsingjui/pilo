use serde::{Deserialize, Serialize};

#[cfg(any(test, target_os = "macos", target_os = "windows"))]
use super::host_events::HostEvents;

#[cfg(any(test, target_os = "macos", target_os = "windows"))]
pub const NOTIFICATION_OPEN_SESSION_EVENT: &str = "pilo://notification-open-session";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotificationSessionTarget {
    pub project_id: String,
    pub session_id: String,
}

#[cfg(any(test, target_os = "macos", target_os = "windows"))]
pub fn emit_open_session(
    events: &dyn HostEvents,
    target: DesktopNotificationSessionTarget,
) -> Result<(), String> {
    events.emit_serialized(NOTIFICATION_OPEN_SESSION_EVENT, target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_events::RecordingEvents;

    #[test]
    fn notification_activation_emits_the_session_target_and_preserves_delivery_errors() {
        let events = RecordingEvents::default();
        for (project_id, session_id) in [("project", "session"), ("", "")] {
            emit_open_session(
                &events,
                DesktopNotificationSessionTarget {
                    project_id: project_id.into(),
                    session_id: session_id.into(),
                },
            )
            .unwrap();
            assert_eq!(
                events.events.lock().unwrap().last().unwrap(),
                &(
                    NOTIFICATION_OPEN_SESSION_EVENT.into(),
                    serde_json::json!({ "projectId": project_id, "sessionId": session_id })
                )
            );
        }
        events
            .fail
            .store(true, std::sync::atomic::Ordering::Relaxed);
        assert_eq!(
            emit_open_session(
                &events,
                DesktopNotificationSessionTarget {
                    project_id: "project".into(),
                    session_id: "session".into()
                }
            ),
            Err("event delivery failed".into())
        );
        assert_eq!(events.events.lock().unwrap().len(), 2);
    }
}
