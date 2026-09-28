use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, State, ipc::Channel};

use super::super::{
    PiloRuntime,
    chat_service::{self, ChatSessionRequest},
    events::{RuntimeEventBus, RuntimeEventEnvelope, TauriEventSink},
    git,
    host_paths::HostPaths,
    pi_workspace, project,
    server_pi::PiLaunchOptions,
    session_snapshot::PiSessionSnapshot,
};

#[tauri::command]
pub fn runtime_subscribe_events(
    events: State<'_, RuntimeEventBus>,
    channel: Channel<RuntimeEventEnvelope>,
) {
    events.subscribe(channel);
}

const APPROVE_PROJECT_MCP_SCRIPT: &str = r#"
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

const serverName = process.argv[1];
if (!serverName) throw new Error("missing MCP server name");
const cwd = process.cwd();
const configPath = join(cwd, ".pi", "mcp-adapter.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const definition = config?.mcpServers?.[serverName];
if (!definition || typeof definition !== "object" || definition.disabled === true) {
  throw new Error(`project MCP server "${serverName}" is not enabled in ${configPath}`);
}
const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalize(entry)]));
};
const definitionHash = createHash("sha256")
  .update(JSON.stringify(canonicalize(definition)))
  .digest("hex");
const canonicalProjectRoot = (value) => {
  try { return realpathSync(value); } catch { return resolve(value); }
};
const linkedWorktreeRepoScope = (dotGit) => {
  try {
    if (!lstatSync(dotGit).isFile()) return undefined;
    const pointer = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
    if (!pointer) return undefined;
    const adminDir = realpathSync(resolve(dirname(dotGit), pointer));
    const backLink = readFileSync(join(adminDir, "gitdir"), "utf8").trim();
    if (realpathSync(resolve(adminDir, backLink)) !== realpathSync(dotGit)) return undefined;
    const commonDir = dirname(dirname(adminDir));
    const bare = /^\s*bare\s*=\s*(true|yes|on|1)\s*$/im.test(readFileSync(join(commonDir, "config"), "utf8"));
    return basename(commonDir) === ".git" && !bare ? dirname(commonDir) : `git-dir:${commonDir}`;
  } catch {
    return undefined;
  }
};
const projectApprovalScope = (value) => {
  const root = canonicalProjectRoot(value);
  for (let dir = root; ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      const repoScope = linkedWorktreeRepoScope(dotGit);
      return repoScope ? join(repoScope, relative(dir, root)) : root;
    }
    if (dirname(dir) === dir) return root;
  }
};
const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
const approvalPath = join(agentDir, "mcp-project-approvals.json");
let store = { version: 1, approvals: [] };
if (existsSync(approvalPath)) {
  const parsed = JSON.parse(readFileSync(approvalPath, "utf8"));
  if (parsed?.version === 1 && Array.isArray(parsed.approvals)) store = parsed;
}
const projectRoot = projectApprovalScope(cwd);
store.approvals = store.approvals.filter((entry) =>
  entry?.projectRoot !== projectRoot || entry?.serverName !== serverName);
store.approvals.push({
  projectRoot,
  serverName,
  definitionHash,
  approvedAt: new Date().toISOString(),
});
mkdirSync(dirname(approvalPath), { recursive: true, mode: 0o700 });
const temporary = `${approvalPath}.${process.pid}.tmp`;
writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
if (process.platform !== "win32") chmodSync(temporary, 0o600);
renameSync(temporary, approvalPath);
if (process.platform !== "win32") chmodSync(approvalPath, 0o600);
"#;

#[tauri::command]
pub async fn project_mcp_server_approve(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    project_id: String,
    server_name: String,
) -> Result<(), String> {
    let server_name = server_name.trim();
    if server_name.is_empty() {
        return Err("MCP server name cannot be empty".to_owned());
    }
    let project = project::get(&app, project_id.trim())?;
    let runtime_project = pi_workspace::resolve_session_project(&app, &project)?;
    let args = vec![
        "--input-type=module".to_owned(),
        "-e".to_owned(),
        APPROVE_PROJECT_MCP_SCRIPT.to_owned(),
        server_name.to_owned(),
    ];
    git::run_checked_owned(&runtime.servers, &runtime_project, "node", &args)
        .await
        .map(|_| ())
}

#[tauri::command]
// Tauri commands expose their arguments flat; the chat session fields are part of the command surface.
#[allow(clippy::too_many_arguments)]
pub async fn chat_session_prepare(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    events: State<'_, RuntimeEventBus>,
    project_id: String,
    session_key: String,
    session_path: Option<String>,
    no_session: bool,
    extensions: Option<Vec<String>>,
) -> Result<PiSessionSnapshot, String> {
    chat_service::prepare(
        &HostPaths::from_app(&app)?,
        &runtime,
        events.inner().clone(),
        ChatSessionRequest {
            project_id,
            session_key,
            session_path,
            no_session,
            extensions: extensions.unwrap_or_default(),
        },
    )
    .await
}

#[tauri::command]
// Tauri commands expose their arguments flat; the chat session fields are part of the command surface.
#[allow(clippy::too_many_arguments)]
pub async fn chat_session_start(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    events: State<'_, RuntimeEventBus>,
    project_id: String,
    session_key: String,
    session_path: Option<String>,
    no_session: bool,
    extensions: Option<Vec<String>>,
) -> Result<PiSessionSnapshot, String> {
    chat_service::start(
        &HostPaths::from_app(&app)?,
        &runtime,
        events.inner().clone(),
        ChatSessionRequest {
            project_id,
            session_key,
            session_path,
            no_session,
            extensions: extensions.unwrap_or_default(),
        },
    )
    .await
}

#[tauri::command]
pub async fn chat_session_send_rpc(
    runtime: State<'_, PiloRuntime>,
    session_key: String,
    command: Value,
) -> Result<(), String> {
    runtime.chat_sessions.send(&session_key, command).await
}

#[tauri::command]
pub async fn chat_session_stop(
    runtime: State<'_, PiloRuntime>,
    session_key: String,
    reason: Option<String>,
) -> Result<(), String> {
    runtime
        .chat_sessions
        .stop(&session_key, reason.as_deref())
        .await
}

#[tauri::command]
pub async fn chat_session_detach(
    runtime: State<'_, PiloRuntime>,
    session_key: String,
    reason: Option<String>,
) -> Result<(), String> {
    runtime
        .chat_sessions
        .detach(&session_key, reason.as_deref())
        .await
}

#[tauri::command]
pub async fn chat_session_state(
    runtime: State<'_, PiloRuntime>,
    session_key: String,
) -> Result<Option<super::super::chat_sessions::ChatSessionState>, String> {
    Ok(runtime.chat_sessions.state(&session_key).await)
}

#[tauri::command]
pub async fn chat_session_states(
    runtime: State<'_, PiloRuntime>,
) -> Result<Vec<super::super::chat_sessions::ChatSessionState>, String> {
    Ok(runtime.chat_sessions.states().await)
}

#[tauri::command]
pub async fn project_start_pi(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
    id: String,
) -> Result<PiSessionSnapshot, String> {
    let project = project::get(&app, &id)?;
    project::touch(&app, &project.id)?;
    let profile = pi_workspace::resolve_pi_runtime(&app, &project, Vec::new())?;
    runtime
        .project_pi_session
        .lock()
        .await
        .spawn(
            Arc::clone(&runtime.servers),
            TauriEventSink::new(app),
            &profile.project,
            PiLaunchOptions {
                extensions: profile.extensions,
                disable_builtin_tools: profile.disable_builtin_tools,
                disable_extension_discovery: profile.disable_extension_discovery,
                disable_context_files: profile.disable_context_files,
                ..PiLaunchOptions::default()
            },
        )
        .await
}

#[tauri::command]
pub async fn runtime_get_pi_state(
    runtime: State<'_, PiloRuntime>,
) -> Result<PiSessionSnapshot, String> {
    Ok(runtime.project_pi_session.lock().await.snapshot())
}

#[tauri::command]
pub async fn runtime_stop_pi(runtime: State<'_, PiloRuntime>) -> Result<PiSessionSnapshot, String> {
    runtime.project_pi_session.lock().await.stop().await
}

#[tauri::command]
pub async fn runtime_restart_pi(
    app: AppHandle,
    runtime: State<'_, PiloRuntime>,
) -> Result<PiSessionSnapshot, String> {
    runtime
        .project_pi_session
        .lock()
        .await
        .restart(Arc::clone(&runtime.servers), TauriEventSink::new(app))
        .await
}

#[tauri::command]
pub async fn runtime_abort_pi(runtime: State<'_, PiloRuntime>) -> Result<(), String> {
    runtime.project_pi_session.lock().await.abort().await
}

#[tauri::command]
pub async fn runtime_send_rpc(
    runtime: State<'_, PiloRuntime>,
    command: Value,
) -> Result<(), String> {
    runtime
        .project_pi_session
        .lock()
        .await
        .send_rpc(command)
        .await
}
