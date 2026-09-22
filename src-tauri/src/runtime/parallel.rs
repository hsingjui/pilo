use std::{
    collections::HashMap,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicU8, AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::domain::{ConnectionKind, Project, ProjectMetadata, ProjectPiRuntime};

use super::{
    events::{PiProcessState, RuntimeEvent, RuntimeEventSink},
    git, pi_workspace,
    server_client::ServerManager,
    server_pi::{PiLaunchOptions, ServerPiSession},
};

pub const PARALLEL_EVENT_NAME: &str = "pilo://parallel-agent";
static AGENT_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ParallelAgentStatus {
    Starting,
    Waiting,
    Busy,
    Stopping,
    Stopped,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParallelAgentInfo {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub branch: String,
    pub worktree_path: String,
    pub status: ParallelAgentStatus,
    pub created_at_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ParallelRuntimeEvent {
    agent_id: String,
    event: RuntimeEvent,
}

struct ParallelAgent {
    info: ParallelAgentInfo,
    status: Arc<AtomicU8>,
    session: ServerPiSession,
}

#[derive(Default)]
pub struct ParallelAgentManager {
    agents: HashMap<String, ParallelAgent>,
}

impl ParallelAgentManager {
    pub fn list(&self, project_id: &str) -> Vec<ParallelAgentInfo> {
        let mut result = self
            .agents
            .values()
            .filter(|agent| agent.info.project_id == project_id)
            .map(|agent| {
                let mut info = agent.info.clone();
                info.status = status_from_u8(agent.status.load(Ordering::Acquire));
                info
            })
            .collect::<Vec<_>>();
        result.sort_by_key(|agent| agent.created_at_ms);
        result
    }

    pub async fn create(
        &mut self,
        servers: Arc<ServerManager>,
        app: AppHandle,
        project: &Project,
        name: String,
        prompt: Option<String>,
    ) -> Result<ParallelAgentInfo, String> {
        let sequence = AGENT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let id = format!("agent-{sequence}");
        let slug = slugify(&name);
        let branch = format!("pilo/{slug}-{sequence}");
        let worktree_path = worktree_path(project, &id)?;
        create_worktree_parent(&servers, project, &worktree_path).await?;
        create_worktree(&servers, project, &branch, &worktree_path).await?;

        let status = Arc::new(AtomicU8::new(status_to_u8(ParallelAgentStatus::Starting)));
        let sink = ParallelEventSink {
            app: app.clone(),
            agent_id: id.clone(),
            status: Arc::clone(&status),
        };
        let mut session = ServerPiSession::default();
        let worktree_project = Project {
            id: project.id.clone(),
            name: project.name.clone(),
            path: worktree_path.clone(),
            connection: project.connection.clone(),
            pi_runtime: project.pi_runtime,
            metadata: ProjectMetadata {
                cwd: worktree_path.clone(),
                git_branch: Some(branch.clone()),
                pi_version: project.metadata.pi_version.clone(),
                refreshed_at_ms: project.metadata.refreshed_at_ms,
            },
            created_at_ms: project.created_at_ms,
            last_opened_at_ms: project.last_opened_at_ms,
        };
        let profile = match pi_workspace::resolve_pi_runtime(&app, &worktree_project, Vec::new()) {
            Ok(profile) => profile,
            Err(error) => {
                let _ = remove_worktree(&servers, project, &branch, &worktree_path).await;
                return Err(error);
            }
        };
        if let Err(error) = session
            .spawn(
                Arc::clone(&servers),
                sink,
                &profile.project,
                PiLaunchOptions {
                    // Local-Pi parallel agents are ephemeral workers. Persisting
                    // them would write into the main project's local session
                    // anchor and surface them in ordinary chat history.
                    no_session: project.pi_runtime == ProjectPiRuntime::Local,
                    extensions: profile.extensions,
                    disable_builtin_tools: profile.disable_builtin_tools,
                    disable_extension_discovery: profile.disable_extension_discovery,
                    disable_context_files: profile.disable_context_files,
                    ..PiLaunchOptions::default()
                },
            )
            .await
        {
            let _ = remove_worktree(&servers, project, &branch, &worktree_path).await;
            return Err(error);
        }

        let info = ParallelAgentInfo {
            id: id.clone(),
            project_id: project.id.clone(),
            name: if name.trim().is_empty() {
                format!("Agent {sequence}")
            } else {
                name.trim().to_owned()
            },
            branch,
            worktree_path,
            status: ParallelAgentStatus::Waiting,
            created_at_ms: now_ms(),
        };
        status.store(
            status_to_u8(ParallelAgentStatus::Waiting),
            Ordering::Release,
        );
        if let Some(prompt) = prompt.filter(|value| !value.trim().is_empty()) {
            session
                .send_rpc(json!({ "type": "prompt", "message": prompt.trim() }))
                .await?;
            status.store(status_to_u8(ParallelAgentStatus::Busy), Ordering::Release);
        }
        self.agents.insert(
            id,
            ParallelAgent {
                info: info.clone(),
                status,
                session,
            },
        );
        Ok(info)
    }

    pub async fn send(&mut self, agent_id: &str, message: String) -> Result<(), String> {
        let agent = self
            .agents
            .get_mut(agent_id)
            .ok_or_else(|| format!("parallel agent '{agent_id}' was not found"))?;
        agent
            .session
            .send_rpc(json!({ "type": "prompt", "message": message }))
            .await?;
        agent
            .status
            .store(status_to_u8(ParallelAgentStatus::Busy), Ordering::Release);
        Ok(())
    }

    pub async fn stop(&mut self, agent_id: &str) -> Result<(), String> {
        let agent = self
            .agents
            .get_mut(agent_id)
            .ok_or_else(|| format!("parallel agent '{agent_id}' was not found"))?;
        agent.status.store(
            status_to_u8(ParallelAgentStatus::Stopping),
            Ordering::Release,
        );
        agent.session.stop().await?;
        agent.status.store(
            status_to_u8(ParallelAgentStatus::Stopped),
            Ordering::Release,
        );
        Ok(())
    }

    pub async fn remove_project(
        &mut self,
        servers: &ServerManager,
        project: &Project,
    ) -> Result<(), String> {
        let ids = self
            .agents
            .values()
            .filter(|agent| agent.info.project_id == project.id)
            .map(|agent| agent.info.id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            self.remove(servers, project, &id).await?;
        }
        Ok(())
    }

    pub async fn remove(
        &mut self,
        servers: &ServerManager,
        project: &Project,
        agent_id: &str,
    ) -> Result<(), String> {
        let Some(mut agent) = self.agents.remove(agent_id) else {
            return Ok(());
        };
        let _ = agent.session.stop().await;
        if let Err(error) = remove_worktree(
            servers,
            project,
            &agent.info.branch,
            &agent.info.worktree_path,
        )
        .await
        {
            self.agents.insert(agent_id.to_owned(), agent);
            return Err(error);
        }
        Ok(())
    }
}

#[derive(Clone)]
struct ParallelEventSink {
    app: AppHandle,
    agent_id: String,
    status: Arc<AtomicU8>,
}

impl RuntimeEventSink for ParallelEventSink {
    fn send(&self, event: RuntimeEvent) {
        let next = match &event {
            RuntimeEvent::ProcessState { state, .. } => Some(match state {
                PiProcessState::Starting => ParallelAgentStatus::Starting,
                PiProcessState::Running => ParallelAgentStatus::Waiting,
                PiProcessState::Stopping => ParallelAgentStatus::Stopping,
                PiProcessState::Stopped => ParallelAgentStatus::Stopped,
                PiProcessState::Failed => ParallelAgentStatus::Failed,
            }),
            RuntimeEvent::AssistantMessageStart { .. }
            | RuntimeEvent::AssistantTextDelta { .. }
            | RuntimeEvent::AssistantThinkingStart { .. }
            | RuntimeEvent::AssistantThinkingDelta { .. }
            | RuntimeEvent::ToolExecutionStart { .. }
            | RuntimeEvent::ToolExecutionUpdate { .. } => Some(ParallelAgentStatus::Busy),
            RuntimeEvent::AssistantMessageEnd { .. } => Some(ParallelAgentStatus::Waiting),
            RuntimeEvent::RuntimeError { .. } => Some(ParallelAgentStatus::Failed),
            _ => None,
        };
        if let Some(status) = next {
            self.status.store(status_to_u8(status), Ordering::Release);
        }
        let _ = self.app.emit(
            PARALLEL_EVENT_NAME,
            ParallelRuntimeEvent {
                agent_id: self.agent_id.clone(),
                event,
            },
        );
    }
}

async fn create_worktree(
    servers: &ServerManager,
    project: &Project,
    branch: &str,
    path: &str,
) -> Result<(), String> {
    let args = vec![
        "worktree".to_owned(),
        "add".to_owned(),
        "-b".to_owned(),
        branch.to_owned(),
        path.to_owned(),
        "HEAD".to_owned(),
    ];
    git::run_checked_owned(servers, project, "git", &args)
        .await
        .map(|_| ())
}

async fn remove_worktree(
    servers: &ServerManager,
    project: &Project,
    branch: &str,
    path: &str,
) -> Result<(), String> {
    let remove_args = vec![
        "worktree".to_owned(),
        "remove".to_owned(),
        "--force".to_owned(),
        path.to_owned(),
    ];
    git::run_checked_owned(servers, project, "git", &remove_args).await?;
    let branch_args = vec!["branch".to_owned(), "-D".to_owned(), branch.to_owned()];
    let _ = git::run(servers, project, "git", &branch_args, &[]).await;
    Ok(())
}

async fn create_worktree_parent(
    servers: &ServerManager,
    project: &Project,
    worktree_path: &str,
) -> Result<(), String> {
    let parent = parent_string(worktree_path)
        .ok_or_else(|| format!("invalid worktree path '{worktree_path}'"))?;
    servers
        .request(
            &project.connection,
            "fs.mkdir_absolute",
            json!({ "path": parent }),
        )
        .await
        .map(|_| ())
}

fn worktree_path(project: &Project, agent_id: &str) -> Result<String, String> {
    match project.connection.kind {
        ConnectionKind::Local => {
            let path = Path::new(&project.path);
            let parent = path
                .parent()
                .ok_or_else(|| "project has no parent directory".to_owned())?;
            let repo = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("project");
            Ok(parent
                .join(".pilo-worktrees")
                .join(repo)
                .join(agent_id)
                .to_string_lossy()
                .into_owned())
        }
        _ => {
            let project_path = project.path.trim_end_matches('/');
            let (parent, repo) = project_path
                .rsplit_once('/')
                .ok_or_else(|| "remote project path must be absolute".to_owned())?;
            Ok(format!("{parent}/.pilo-worktrees/{repo}/{agent_id}"))
        }
    }
}

fn parent_string(path: &str) -> Option<String> {
    Path::new(path)
        .parent()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.is_empty())
        .or_else(|| path.rsplit_once('/').map(|(parent, _)| parent.to_owned()))
}

fn slugify(value: &str) -> String {
    let mut slug = value
        .trim()
        .to_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    let slug = slug.trim_matches('-').to_owned();
    if slug.is_empty() {
        "task".to_owned()
    } else {
        slug.chars().take(40).collect()
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

const fn status_to_u8(status: ParallelAgentStatus) -> u8 {
    match status {
        ParallelAgentStatus::Starting => 0,
        ParallelAgentStatus::Waiting => 1,
        ParallelAgentStatus::Busy => 2,
        ParallelAgentStatus::Stopping => 3,
        ParallelAgentStatus::Stopped => 4,
        ParallelAgentStatus::Failed => 5,
    }
}

const fn status_from_u8(value: u8) -> ParallelAgentStatus {
    match value {
        1 => ParallelAgentStatus::Waiting,
        2 => ParallelAgentStatus::Busy,
        3 => ParallelAgentStatus::Stopping,
        4 => ParallelAgentStatus::Stopped,
        5 => ParallelAgentStatus::Failed,
        _ => ParallelAgentStatus::Starting,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_slug_is_safe_and_bounded() {
        assert_eq!(slugify("Fix Login Flow"), "fix-login-flow");
        assert_eq!(slugify("***"), "task");
        assert!(slugify(&"a".repeat(80)).len() <= 40);
    }

    #[test]
    fn remote_worktree_path_is_sibling_scoped() {
        let project = Project {
            id: "w".to_owned(),
            name: "repo".to_owned(),
            path: "/srv/code/repo".to_owned(),
            connection: crate::domain::Connection {
                id: "wsl".to_owned(),
                name: "WSL".to_owned(),
                pi_executable: None,
                kind: ConnectionKind::Wsl {
                    distro: "Ubuntu".to_owned(),
                },
            },
            pi_runtime: crate::domain::ProjectPiRuntime::Workspace,
            metadata: crate::domain::ProjectMetadata {
                cwd: "/srv/code/repo".to_owned(),
                git_branch: None,
                pi_version: String::new(),
                refreshed_at_ms: 0,
            },
            created_at_ms: 0,
            last_opened_at_ms: 0,
        };
        assert_eq!(
            worktree_path(&project, "agent-7").unwrap(),
            "/srv/code/.pilo-worktrees/repo/agent-7"
        );
    }
}
