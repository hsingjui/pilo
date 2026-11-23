use serde_json::Value;

use super::{
    Runtime,
    chat_service::{self, ChatSessionRequest},
    git, pi_workspace, project,
    session_snapshot::PiSessionSnapshot,
};

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

pub async fn project_mcp_server_approve(
    runtime: &Runtime,
    project_id: String,
    server_name: String,
) -> Result<(), String> {
    let server_name = server_name.trim();
    if server_name.is_empty() {
        return Err("MCP server name cannot be empty".to_owned());
    }
    let project = project::get(runtime, project_id.trim())?;
    let runtime_project =
        pi_workspace::resolve_session_project_with_paths(&runtime.paths, &project)?;
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

// The native class passes the chat session fields flat, as its JS method takes them.
#[allow(clippy::too_many_arguments)]
pub async fn chat_session_start(
    runtime: &Runtime,
    project_id: String,
    session_key: String,
    session_path: Option<String>,
    no_session: bool,
    extensions: Option<Vec<String>>,
    builtin_extensions: Option<Vec<pilo_protocol::BuiltinExtension>>,
) -> Result<PiSessionSnapshot, String> {
    chat_service::start(
        &runtime.paths,
        runtime,
        runtime.events.clone(),
        ChatSessionRequest {
            project_id,
            session_key,
            session_path,
            no_session,
            extensions: extensions.unwrap_or_default(),
            builtin_extensions: builtin_extensions.unwrap_or_default(),
        },
    )
    .await
}

pub async fn chat_session_send_rpc(
    runtime: &Runtime,
    session_key: String,
    command: Value,
) -> Result<(), String> {
    let _policy = runtime.pi_resource_policy.read().await;
    runtime.chat_sessions.send(&session_key, command).await
}

pub async fn chat_session_stop(
    runtime: &Runtime,
    session_key: String,
    reason: Option<String>,
) -> Result<(), String> {
    runtime
        .chat_sessions
        .stop(&session_key, reason.as_deref())
        .await
}

pub async fn chat_session_state(
    runtime: &Runtime,
    session_key: String,
) -> Result<Option<super::chat_sessions::ChatSessionState>, String> {
    Ok(runtime.chat_sessions.state(&session_key).await)
}

pub async fn chat_session_states(
    runtime: &Runtime,
) -> Result<Vec<super::chat_sessions::ChatSessionState>, String> {
    Ok(runtime.chat_sessions.states().await)
}

#[cfg(test)]
mod tests {

    use super::*;

    #[tokio::test]
    async fn runtime_session_functions_handle_empty_state_and_unknown_sessions() {
        let root = std::env::temp_dir().join(format!("pilo-runtime-chat-{}", std::process::id()));
        let runtime = Runtime::new(
            super::super::host_paths::HostPaths::new(root.clone(), root.join("resources")).unwrap(),
        );
        assert!(chat_session_states(&runtime).await.unwrap().is_empty());
        assert!(
            chat_session_state(&runtime, "missing".into())
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            chat_session_send_rpc(&runtime, "missing".into(), Value::Null)
                .await
                .is_err()
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
