//! Host operations shared by the embedded desktop and the Remote Gateway.

use std::{future::Future, io, pin::Pin, time::Duration};

use pilo_domain::RemoteScopes;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

use crate::Runtime;

mod handlers;
mod validation;
pub use handlers::methods;

pub const PROTOCOL_VERSION: &str = "2.0";
pub const MAX_JSON_REQUEST_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_TERMINAL_WRITE_BYTES: usize = 1024 * 1024;
pub const MAX_BLOB_OUTPUT_BYTES: usize = 10 * 1024 * 1024;
pub const GATEWAY_TIMEOUT: Duration = Duration::from_secs(45);

pub fn method_table_json() -> Value {
    let entries: Vec<Value> = methods()
        .iter()
        .map(|spec| {
            serde_json::json!({
                "name": spec.name,
                "scope": spec.scope,
                "kind": spec.kind,
                "maxRequestBytes": spec.limits.max_request_bytes,
                "maxBinaryInputBytes": spec.limits.max_binary_input_bytes,
                "timeoutMs": u64::try_from(spec.limits.timeout.as_millis()).unwrap_or(u64::MAX),
                "params": spec.params.iter().map(|param| serde_json::json!({
                    "name": param.key(),
                    "type": param.ty.replace(' ', ""),
                    "optional": param.optional(),
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    serde_json::json!({
        "protocolVersion": PROTOCOL_VERSION,
        "methods": entries,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Chat,
    Workspace,
    Admin,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Principal {
    Local,
    Device { id: String, scopes: RemoteScopes },
}

impl Principal {
    pub(crate) fn allows(&self, scope: Scope) -> bool {
        match (self, scope) {
            (Self::Local, _) | (Self::Device { .. }, Scope::Chat) => true,
            (Self::Device { scopes, .. }, Scope::Workspace) => {
                *scopes == RemoteScopes::ChatWorkspace
            }
            (Self::Device { .. }, Scope::Admin) => false,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MethodKind {
    Json,
    BinaryIn,
    BinaryOut,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    /// Serialized JSON parameters, independent of the transport.
    pub max_request_bytes: usize,
    /// Additional raw body limit for binary input.
    pub max_binary_input_bytes: Option<usize>,
    /// Gateway deadline. In-process calls retain their existing lifecycle.
    pub timeout: Duration,
}

impl Limits {
    const JSON: Self = Self {
        max_request_bytes: MAX_JSON_REQUEST_BYTES,
        max_binary_input_bytes: None,
        timeout: GATEWAY_TIMEOUT,
    };

    const fn binary_input(max_bytes: usize) -> Self {
        Self {
            max_binary_input_bytes: Some(max_bytes),
            ..Self::JSON
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MethodSpec {
    pub name: &'static str,
    pub scope: Scope,
    pub kind: MethodKind,
    pub limits: Limits,
    /// JSON parameters in declaration order.
    pub params: &'static [MethodParam],
}

/// One JSON parameter: its Rust field name and Rust type as written in the registry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MethodParam {
    pub name: &'static str,
    pub ty: &'static str,
}

impl MethodParam {
    /// The camelCase key callers send.
    pub fn key(&self) -> String {
        let mut key = String::with_capacity(self.name.len());
        let mut upper = false;
        for character in self.name.chars() {
            if character == '_' {
                upper = true;
            } else if upper {
                key.extend(character.to_uppercase());
                upper = false;
            } else {
                key.push(character);
            }
        }
        key
    }

    pub fn optional(&self) -> bool {
        self.ty.replace(' ', "").starts_with("Option<")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Unauthorized,
    Forbidden,
    NotFound,
    InvalidParams,
    Unavailable,
    Timeout,
    Internal,
    /// The target's current state refuses the request (busy, not running, Pi rejected it).
    Conflict,
    /// A write may or may not have taken effect; callers must not retry automatically.
    OutcomeUnknown,
}

#[derive(Debug, PartialEq, Eq, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct HostApiError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    /// Gateways answer with 413 Payload Too Large.
    #[serde(skip)]
    pub too_large: bool,
}

impl HostApiError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: matches!(code, ErrorCode::Unavailable | ErrorCode::Timeout),
            too_large: false,
        }
    }

    pub(crate) fn too_large(message: impl Into<String>) -> Self {
        Self {
            too_large: true,
            ..Self::invalid(message)
        }
    }

    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidParams, message)
    }

    pub(crate) fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message)
    }

    pub(crate) fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }
}

/// Reading an image failed, or the image is over its size limit.
#[derive(Debug)]
pub(crate) enum ImageReadError {
    TooLarge(String),
    Failed(String),
}

impl ImageReadError {
    pub(crate) fn into_host_error(self, failed: fn(String) -> HostApiError) -> HostApiError {
        match self {
            Self::TooLarge(message) => HostApiError::too_large(message),
            Self::Failed(message) => failed(message),
        }
    }

    pub(crate) fn into_message(self) -> String {
        match self {
            Self::TooLarge(message) | Self::Failed(message) => message,
        }
    }
}

impl From<String> for ImageReadError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

pub enum BinaryOutput {
    Json(Value),
    Bytes(Vec<u8>),
}

enum Output {
    Json(Value),
    EncodedJson(Vec<u8>),
    Bytes(Vec<u8>),
}

type CallResult = Result<Output, HostApiError>;
type CallFuture<'a> = Pin<Box<dyn Future<Output = CallResult> + Send + 'a>>;

pub async fn call(
    rt: &Runtime,
    who: &Principal,
    method: &str,
    params: Value,
) -> Result<Value, HostApiError> {
    match execute(rt, who, method, params, CallKind::Json).await? {
        Output::Json(value) => Ok(value),
        Output::EncodedJson(bytes) => {
            blocking(move || {
                serde_json::from_slice(&bytes)
                    .map_err(|err| HostApiError::internal(err.to_string()))
            })
            .await
        }
        Output::Bytes(_) => unreachable!("JSON handlers return JSON"),
    }
}

/// Lets v1 return the history cache's serialized JSON directly.
pub(crate) async fn call_json_bytes(
    rt: &Runtime,
    who: &Principal,
    method: &str,
    params: Value,
) -> Result<Vec<u8>, HostApiError> {
    match execute(rt, who, method, params, CallKind::Json).await? {
        Output::Json(value) => {
            serde_json::to_vec(&value).map_err(|err| HostApiError::internal(err.to_string()))
        }
        Output::EncodedJson(bytes) => Ok(bytes),
        Output::Bytes(_) => unreachable!("JSON handlers return JSON"),
    }
}

pub async fn call_binary(
    rt: &Runtime,
    who: &Principal,
    method: &str,
    params: Value,
    bytes: Option<&[u8]>,
) -> Result<BinaryOutput, HostApiError> {
    match execute(rt, who, method, params, CallKind::Binary(bytes)).await? {
        Output::Json(value) => Ok(BinaryOutput::Json(value)),
        Output::Bytes(bytes) => Ok(BinaryOutput::Bytes(bytes)),
        Output::EncodedJson(_) => unreachable!("binary handlers return bytes or a JSON value"),
    }
}

enum CallKind<'a> {
    Json,
    Binary(Option<&'a [u8]>),
}

async fn execute(
    rt: &Runtime,
    who: &Principal,
    method: &str,
    params: Value,
    call_kind: CallKind<'_>,
) -> CallResult {
    let spec = methods()
        .iter()
        .find(|spec| spec.name == method)
        .ok_or_else(|| HostApiError::not_found(format!("Unknown Host API method '{method}'")))?;
    if !who.allows(spec.scope) {
        return Err(HostApiError::new(
            ErrorCode::Forbidden,
            format!("Access to '{method}' is forbidden"),
        ));
    }
    let bytes = match (spec.kind, call_kind) {
        (MethodKind::Json, CallKind::Json) | (MethodKind::BinaryOut, CallKind::Binary(None)) => {
            None
        }
        (MethodKind::BinaryIn, CallKind::Binary(Some(bytes))) => Some(bytes),
        _ => {
            return Err(HostApiError::invalid(format!(
                "Invalid request kind for '{method}'"
            )));
        }
    };
    validation::check_json_size(&params, spec.limits.max_request_bytes)?;
    if let Some((bytes, limit)) = bytes.zip(spec.limits.max_binary_input_bytes)
        && bytes.len() > limit
    {
        let message = if spec.name == "chat.files.upload" {
            "chat attachment exceeds the 10 MB limit".to_owned()
        } else {
            format!("'{method}' binary input exceeds {limit} bytes")
        };
        return Err(HostApiError::too_large(message));
    }
    handlers::dispatch(rt, who, spec.name, params, bytes).await
}

fn decode<T: DeserializeOwned>(value: Value) -> Result<T, HostApiError> {
    serde_json::from_value(value).map_err(|err| HostApiError::invalid(err.to_string()))
}

fn json(value: impl Serialize) -> CallResult {
    serde_json::to_value(value)
        .map(Output::Json)
        .map_err(|err| HostApiError::internal(err.to_string()))
}

async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, HostApiError> + Send + 'static,
) -> Result<T, HostApiError> {
    tokio::task::spawn_blocking(task)
        .await
        .map_err(|err| HostApiError::internal(format!("Host API task failed: {err}")))?
}

struct ByteBudget(usize);

impl io::Write for ByteBudget {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0 = self
            .0
            .checked_sub(buf.len())
            .ok_or(io::ErrorKind::FileTooLarge)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[tokio::test]
    async fn registry_enforces_scopes_before_decoding_parameters() {
        let runtime = Runtime::new(crate::host_paths::HostPaths::for_test(
            std::path::PathBuf::new(),
        ));
        let params = || serde_json::json!({});
        let chat = Principal::Device {
            id: "chat".into(),
            scopes: RemoteScopes::Chat,
        };
        let workspace = Principal::Device {
            id: "workspace".into(),
            scopes: RemoteScopes::ChatWorkspace,
        };
        for principal in [&chat, &workspace] {
            for method in ["session.status", "session.create", "session.send"] {
                assert_eq!(
                    call(&runtime, principal, method, params())
                        .await
                        .unwrap_err()
                        .code,
                    ErrorCode::Forbidden,
                    "{method}"
                );
            }
        }
        assert_eq!(
            call(&runtime, &Principal::Local, "session.status", params())
                .await
                .unwrap_err()
                .code,
            ErrorCode::InvalidParams
        );
        for (principal, workspace_error, admin_error) in [
            (
                &Principal::Local,
                ErrorCode::InvalidParams,
                ErrorCode::InvalidParams,
            ),
            (&chat, ErrorCode::Forbidden, ErrorCode::Forbidden),
            (&workspace, ErrorCode::InvalidParams, ErrorCode::Forbidden),
        ] {
            assert_eq!(
                call(&runtime, principal, "chat.rpc", params())
                    .await
                    .unwrap_err()
                    .code,
                ErrorCode::InvalidParams
            );
            assert_eq!(
                call(&runtime, principal, "project.add", params())
                    .await
                    .unwrap_err()
                    .code,
                workspace_error
            );
            assert_eq!(
                call(&runtime, principal, "connection.namingModels.set", params())
                    .await
                    .unwrap_err()
                    .code,
                admin_error
            );
        }
    }

    #[test]
    fn every_method_has_a_unique_name_and_the_expected_scope() {
        let mut workspace = HashSet::from([
            "chat.mcp.approve",
            "connection.readDir",
            "git.diff",
            "git.status",
            "project.add",
            "project.file.preview",
            "project.remove",
            "terminal.attach",
            "terminal.close",
            "terminal.open",
            "terminal.resize",
            "terminal.snapshot",
            "terminal.write",
        ]);
        let mut admin = HashSet::from([
            "connection.local.test",
            "connection.localPiResources.set",
            "connection.namingModels.set",
            "connection.pi.probe",
            "connection.settings.update",
            "connection.shownInHome.set",
            "connection.ssh.agentIdentities",
            "connection.ssh.configHosts",
            "connection.ssh.localKeys",
            "connection.ssh.password",
            "connection.ssh.remove",
            "connection.ssh.save",
            "connection.ssh.test",
            "connection.ssh.testDraft",
            "connection.wsl.distributions",
            "connection.wsl.remove",
            "connection.wsl.save",
            "connection.wsl.test",
            "host.shutdown",
            "remote.addresses.set",
            "remote.device.rename",
            "remote.device.revoke",
            "remote.devices.revokeAll",
            "remote.devices.setScopes",
            "remote.enabled.set",
            "remote.lanAddresses",
            "remote.pairing.regenerate",
            "remote.port.set",
            "remote.state",
            "session.resolve",
            "session.page",
            "session.create",
            "session.send",
            "session.abort",
            "session.stop",
            "session.update",
            "session.trash",
            "session.status",
            "desktop.open",
        ]);
        let mut names = HashSet::new();
        for spec in methods() {
            assert!(names.insert(spec.name), "duplicate method {}", spec.name);
            let scope = if workspace.remove(spec.name) {
                Scope::Workspace
            } else if admin.remove(spec.name) {
                Scope::Admin
            } else {
                Scope::Chat
            };
            assert_eq!(spec.scope, scope, "{}", spec.name);
            assert_eq!(
                spec.kind == MethodKind::BinaryIn,
                spec.limits.max_binary_input_bytes.is_some(),
                "{}",
                spec.name
            );
        }
        assert!(workspace.is_empty() && admin.is_empty());
        assert!(names.contains("host.bootstrap"));
    }

    #[test]
    fn generated_host_methods_json_matches_registry() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../shared/api/host-methods.json");
        let raw = std::fs::read_to_string(&path).unwrap_or_else(|error| {
            panic!(
                "failed to read {} (run `pnpm generate:host-api`): {error}",
                path.display()
            )
        });
        let parsed: Value = serde_json::from_str(&raw).expect("valid host-methods.json");
        assert_eq!(
            parsed,
            method_table_json(),
            "shared/api/host-methods.json is out of sync; run `pnpm generate:host-api`"
        );
    }
}
