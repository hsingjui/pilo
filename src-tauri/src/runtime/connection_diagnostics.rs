use std::{
    process::ExitStatus,
    sync::atomic::{AtomicU64, Ordering},
    time::Instant,
};

use crate::domain::{Connection, ConnectionKind, SshAuthMethod, SshTarget};

pub(super) struct ConnectionDiagnostics {
    pub(super) attempt_id: u64,
    connection_id: String,
}

impl ConnectionDiagnostics {
    pub(super) fn new(connection: &Connection) -> Self {
        static NEXT_ATTEMPT: AtomicU64 = AtomicU64::new(1);
        let diagnostics = Self {
            attempt_id: NEXT_ATTEMPT.fetch_add(1, Ordering::Relaxed),
            connection_id: connection.id.clone(),
        };
        let (kind, mode, auth, proxy_jump) = match &connection.kind {
            ConnectionKind::Local => ("local", "none", "none", false),
            ConnectionKind::Wsl { .. } => ("wsl", "none", "none", false),
            ConnectionKind::Ssh { target } => {
                let auth = match target.auth_method() {
                    SshAuthMethod::Agent | SshAuthMethod::AgentKey(_) => "agent",
                    SshAuthMethod::Password => "password",
                    SshAuthMethod::Key => "key",
                };
                let (mode, proxy_jump) = match target {
                    SshTarget::ConfigHost { .. } => ("config", false),
                    SshTarget::Direct { proxy_jump, .. } => ("direct", proxy_jump.is_some()),
                };
                ("ssh", mode, auth, proxy_jump)
            }
        };
        log::info!(target: "connection-diagnostics", "context pid={} attemptId={} connectionId={:?} kind={kind} mode={mode} auth={auth} proxyJump={proxy_jump} piRuntime={} hostOs={} hostArch={} piloVersion={}", std::process::id(), diagnostics.attempt_id, diagnostics.connection_id, connection.pi_runtime.as_str(), std::env::consts::OS, std::env::consts::ARCH, env!("CARGO_PKG_VERSION"));
        diagnostics
    }

    pub(super) fn stage(&self, name: &'static str) -> ConnectionStage<'_> {
        log::info!(target: "connection-diagnostics", "stage begin attemptId={} connectionId={:?} stage={name}", self.attempt_id, self.connection_id);
        ConnectionStage {
            diagnostics: self,
            name,
            started: Instant::now(),
            finished: false,
        }
    }

    pub(super) fn process_exit(
        &self,
        stage: &'static str,
        status: Option<ExitStatus>,
        stderr: &[u8],
    ) {
        let success = status.map(|status| status.success());
        let stderr_text = String::from_utf8_lossy(stderr);
        let askpass_ok = stderr_text
            .lines()
            .filter(|line| line.starts_with(super::ssh::ASKPASS_DIAGNOSTIC_PREFIX))
            .map(|line| line.contains(" ok=true "))
            .reduce(|previous, next| previous && next);
        let level = if success == Some(true) {
            log::Level::Info
        } else {
            log::Level::Warn
        };
        log::log!(target: "connection-diagnostics", level, "process exit attemptId={} connectionId={:?} stage={stage} success={success:?} exitCode={:?} stderrBytes={} askpassOk={askpass_ok:?} reason={}", self.attempt_id, self.connection_id, status.and_then(|status| status.code()), stderr.len(), if success == Some(true) { "none" } else { failure_reason(&stderr_text) });
    }

    pub(super) fn io_error(&self, stage: &'static str, error: &std::io::Error) {
        log::warn!(target: "connection-diagnostics", "I/O failed attemptId={} connectionId={:?} stage={stage} kind={:?} osCode={:?}", self.attempt_id, self.connection_id, error.kind(), error.raw_os_error());
    }
}

pub(super) struct ConnectionStage<'a> {
    diagnostics: &'a ConnectionDiagnostics,
    name: &'static str,
    started: Instant,
    finished: bool,
}

impl ConnectionStage<'_> {
    pub(super) fn finish<T>(mut self, result: Result<T, String>) -> Result<T, String> {
        self.finished = true;
        let level = if result.is_ok() {
            log::Level::Info
        } else {
            log::Level::Warn
        };
        let reason = result
            .as_ref()
            .err()
            .map_or("none", |error| failure_reason(error));
        log::log!(target: "connection-diagnostics", level, "stage end attemptId={} connectionId={:?} stage={} ok={} elapsedMs={} reason={reason}", self.diagnostics.attempt_id, self.diagnostics.connection_id, self.name, result.is_ok(), self.started.elapsed().as_millis());
        result
    }
}

impl Drop for ConnectionStage<'_> {
    fn drop(&mut self) {
        if !self.finished {
            log::warn!(target: "connection-diagnostics", "stage interrupted attemptId={} connectionId={:?} stage={} elapsedMs={}", self.diagnostics.attempt_id, self.diagnostics.connection_id, self.name, self.started.elapsed().as_millis());
        }
    }
}

pub(super) fn request_failure_reason(method: &str, error: &str) -> Option<&'static str> {
    if matches!(
        error,
        "Pi stream startup cancelled"
            | "session changed while history was being read"
            | "session history loading is shutting down"
    ) {
        return None;
    }
    let reason = failure_reason(error);
    if (method == "fs.stat" && (error.ends_with("(os error 2)") || error.ends_with("(os error 3)")))
        || (matches!(method, "pi.stop" | "terminal.close" | "session.watch_stop")
            && matches!(
                reason,
                "connection_closed" | "server_disconnected" | "server_stopped"
            ))
    {
        return None;
    }
    Some(reason)
}

// Only emit fixed labels: remote stderr and keyring error payloads may contain secrets.
pub(super) fn failure_reason(error: &str) -> &'static str {
    let text = error.to_ascii_lowercase();
    for (needle, reason) in [
        ("reason=credential_missing", "credential_missing"),
        (
            "reason=credential_access_denied",
            "credential_access_denied",
        ),
        (
            "reason=credential_platform_failure",
            "credential_platform_failure",
        ),
        ("reason=credential_bad_encoding", "credential_bad_encoding"),
        ("reason=credential_invalid", "credential_invalid"),
        ("reason=credential_ambiguous", "credential_ambiguous"),
        ("reason=credential_unknown", "credential_unknown"),
        ("failed to read ssh password", "credential_read_failed"),
        ("failed to save ssh password", "credential_write_failed"),
        ("system credential store", "credential_store_failed"),
        ("ssh password is required", "credential_missing"),
        ("ssh_askpass:", "askpass_launch_failed"),
        ("cannot run ssh_askpass", "askpass_launch_failed"),
        (
            "permission denied (os error",
            "filesystem_permission_denied",
        ),
        ("permission denied (", "authentication_rejected"),
        (
            "permission denied, please try again",
            "authentication_rejected",
        ),
        ("authentication failed", "authentication_rejected"),
        (
            "no supported authentication methods",
            "authentication_method_unavailable",
        ),
        (
            "too many authentication failures",
            "authentication_attempts_exceeded",
        ),
        (
            "host key verification failed",
            "host_key_verification_failed",
        ),
        ("remote host identification has changed", "host_key_changed"),
        ("could not resolve hostname", "hostname_resolution_failed"),
        ("connection refused", "connection_refused"),
        ("no route to host", "host_unreachable"),
        ("network is unreachable", "network_unreachable"),
        ("connection reset", "connection_reset"),
        ("connection closed", "connection_closed"),
        ("connection is closed", "connection_closed"),
        ("no matching", "ssh_negotiation_failed"),
        ("bad configuration option", "ssh_config_invalid"),
        ("bad owner or permissions", "ssh_file_permissions"),
        ("timed out", "timeout"),
        ("timeout", "timeout"),
        ("fingerprint_mismatch", "fingerprint_mismatch"),
        ("upload was truncated", "upload_truncated"),
        ("deploy status", "deploy_status_invalid"),
        ("platform probe response", "platform_response_invalid"),
        ("not supported", "unsupported_target"),
        ("not bundled", "unsupported_target"),
        ("runtime is missing", "runtime_unavailable"),
        ("protocol mismatch", "protocol_mismatch"),
        ("missing required capabilities", "capability_mismatch"),
        ("server disconnected", "server_disconnected"),
        ("watcher disconnected", "server_disconnected"),
        ("pilo-server stopped", "server_stopped"),
        ("response channel closed", "connection_closed"),
        ("event channel closed", "event_channel_closed"),
        ("protocol read failed", "protocol_read_failed"),
        ("write failed", "transport_write_failed"),
        ("invalid pilo-server response", "invalid_response"),
        ("unexpected binary", "invalid_response"),
        ("request is invalid", "invalid_request"),
        ("database is locked", "database_locked"),
        ("database disk image is malformed", "database_corrupt"),
        ("no such file", "file_not_found"),
        ("os error 2)", "file_not_found"),
        ("os error 3)", "file_not_found"),
        ("permission denied", "filesystem_permission_denied"),
        ("no space left", "disk_full"),
        ("read-only file system", "filesystem_read_only"),
    ] {
        if text.contains(needle) {
            return reason;
        }
    }
    "unclassified"
}

#[cfg(test)]
mod tests {
    use super::{failure_reason, request_failure_reason};

    #[test]
    fn expected_cancellation_and_stale_history_are_quiet() {
        for method in ["pi.start", "session.read", "http"] {
            for error in [
                "Pi stream startup cancelled",
                "session changed while history was being read",
                "session history loading is shutting down",
            ] {
                assert_eq!(request_failure_reason(method, error), None);
            }
        }
    }

    #[test]
    fn missing_files_are_quiet_only_for_stat() {
        for error in [
            "failed to stat path: No such file or directory (os error 2)",
            "failed to stat path: The system cannot find the path specified. (os error 3)",
        ] {
            assert_eq!(request_failure_reason("fs.stat", error), None);
            assert_eq!(
                request_failure_reason("fs.read_file", error),
                Some("file_not_found")
            );
        }
        assert_eq!(
            request_failure_reason("fs.stat", "Permission denied (os error 13)"),
            Some("filesystem_permission_denied")
        );
    }

    #[test]
    fn cleanup_suppresses_only_expected_disconnects() {
        for method in ["pi.stop", "terminal.close", "session.watch_stop"] {
            for error in [
                "pilo-server connection is closed",
                "pilo-server response channel closed",
                "server disconnected",
                "pilo-server stopped",
            ] {
                assert_eq!(request_failure_reason(method, error), None);
                assert!(request_failure_reason("pi.send", error).is_some());
            }
            assert_eq!(
                request_failure_reason(method, "request timed out"),
                Some("timeout")
            );
        }
    }

    #[test]
    fn unknown_errors_use_a_fixed_label_without_echoing_payloads() {
        assert_eq!(
            request_failure_reason("http", "unexpected response: token=private-value"),
            Some("unclassified")
        );
    }

    #[test]
    fn credential_diagnostics_distinguish_read_failure_from_ssh_rejection() {
        assert_eq!(
            failure_reason(
                "[pilo-ssh-askpass] ok=false reason=credential_access_denied\nPermission denied (password)."
            ),
            "credential_access_denied"
        );
        assert_eq!(
            failure_reason("[pilo-ssh-askpass] ok=true reason=none\nPermission denied (password)."),
            "authentication_rejected"
        );
    }
}
