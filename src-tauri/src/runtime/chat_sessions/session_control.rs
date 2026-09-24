use std::sync::atomic::Ordering;

use serde_json::{Value, json};

use super::{super::debug_trace::runtime_trace, ChatSessions};

impl ChatSessions {
    pub async fn send(&self, session_key: &str, command: Value) -> Result<(), String> {
        let command_type = command
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_owned();
        let command_id = command.get("id").and_then(Value::as_str).map(str::to_owned);
        let process = self
            .registry
            .lock()
            .await
            .processes
            .get(session_key)
            .cloned()
            .ok_or_else(|| format!("session '{session_key}' is not running"))?;
        let session = process.session.lock().await;
        if process.closed.load(Ordering::Acquire) {
            return Err("project is closing".to_owned());
        }
        runtime_trace(
            "chat.send.begin",
            Some(session_key),
            session.stream_id(),
            json!({ "command": command_type, "id": command_id }),
        );
        let result = session.send_rpc(command).await;
        runtime_trace(
            "chat.send.end",
            Some(session_key),
            session.stream_id(),
            json!({
                "command": command_type,
                "id": command_id,
                "ok": result.is_ok(),
                "error": result.as_ref().err(),
            }),
        );
        result
    }

    pub async fn stop(&self, session_key: &str, reason: Option<&str>) -> Result<(), String> {
        let process = {
            let mut registry = self.registry.lock().await;
            registry.processes.remove(session_key)
        };
        let Some(process) = process else {
            runtime_trace(
                "chat.stop",
                Some(session_key),
                None,
                json!({ "found": false, "reason": reason }),
            );
            return Ok(());
        };
        process.closed.store(true, Ordering::Release);
        let mut session = process.session.lock().await;
        runtime_trace(
            "chat.stop.begin",
            Some(session_key),
            session.stream_id(),
            json!({
                "found": true,
                "reason": reason,
                "prepared": process.prepared.load(Ordering::Acquire),
                "initialized": process.initialized.load(Ordering::Acquire),
                "activeTurn": process.active_turn.load(Ordering::Acquire),
                "hasSessionPath": process
                    .session_path
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .is_some(),
            }),
        );
        let result = session.stop().await;
        runtime_trace(
            "chat.stop.end",
            Some(session_key),
            session.stream_id(),
            json!({
                "ok": result.is_ok(),
                "reason": reason,
                "error": result.as_ref().err(),
            }),
        );
        result?;
        Ok(())
    }

    pub async fn detach(&self, session_key: &str, reason: Option<&str>) -> Result<(), String> {
        let process = {
            let mut registry = self.registry.lock().await;
            registry.processes.remove(session_key)
        };
        let Some(process) = process else {
            runtime_trace(
                "chat.detach",
                Some(session_key),
                None,
                json!({ "found": false, "reason": reason }),
            );
            return Ok(());
        };

        process.closed.store(true, Ordering::Release);
        let detached_session_key = session_key.to_owned();
        let detached_reason = reason.map(str::to_owned);
        runtime_trace(
            "chat.detach",
            Some(session_key),
            None,
            json!({ "found": true, "reason": reason }),
        );

        tokio::spawn(async move {
            let mut session = process.session.lock().await;
            runtime_trace(
                "chat.detach.stop.begin",
                Some(&detached_session_key),
                session.stream_id(),
                json!({ "reason": detached_reason }),
            );
            let result = session.stop().await;
            runtime_trace(
                "chat.detach.stop.end",
                Some(&detached_session_key),
                session.stream_id(),
                json!({
                    "ok": result.is_ok(),
                    "reason": detached_reason,
                    "error": result.as_ref().err(),
                }),
            );
        });

        Ok(())
    }
}
