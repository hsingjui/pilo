//! Desktop navigation requested by local clients (`pilo open`): the Host
//! resolves the target, queues it for the desktop UI and waits for its receipt.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex as SyncMutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use pilo_domain::{ConnectionKind, Project, SessionIndexEntry};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::{Mutex, mpsc, oneshot, watch};

use crate::{
    Runtime,
    host_api::{ErrorCode, HostApiError},
    project, project_api, session_api,
};

/// How long a request waits for the desktop UI to start taking navigations.
const UI_READY_TIMEOUT: Duration = Duration::from_secs(30);
/// How long the UI has to apply a navigation and answer.
const RECEIPT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_LISTED_CANDIDATES: usize = 10;

/// One navigation for the desktop UI; answered with `Navigator::complete`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationRequest {
    pub id: u64,
    pub project_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_path: Option<String>,
}

type Receipt = oneshot::Sender<Result<(), String>>;

/// The queue between local clients and the desktop UI.
pub struct Navigator {
    sender: mpsc::UnboundedSender<NavigationRequest>,
    receiver: Mutex<mpsc::UnboundedReceiver<NavigationRequest>>,
    pending: SyncMutex<HashMap<u64, Receipt>>,
    ready: watch::Sender<bool>,
    closed: watch::Sender<bool>,
    next_id: AtomicU64,
    ui_ready_timeout: Duration,
    receipt_timeout: Duration,
}

impl Default for Navigator {
    fn default() -> Self {
        let (sender, receiver) = mpsc::unbounded_channel();
        Self {
            sender,
            receiver: Mutex::new(receiver),
            pending: SyncMutex::default(),
            ready: watch::channel(false).0,
            closed: watch::channel(false).0,
            next_id: AtomicU64::new(1),
            ui_ready_timeout: UI_READY_TIMEOUT,
            receipt_timeout: RECEIPT_TIMEOUT,
        }
    }
}

impl Navigator {
    /// Waits for the next navigation the UI should apply; `None` once closed.
    /// The first call marks the UI ready. Requests whose caller gave up are skipped.
    pub async fn next(&self) -> Option<NavigationRequest> {
        self.ready.send_replace(true);
        let mut closed = self.closed.subscribe();
        let mut receiver = self.receiver.lock().await;
        loop {
            if *closed.borrow() {
                return None;
            }
            let request = tokio::select! {
                request = receiver.recv() => request?,
                _ = closed.changed() => return None,
            };
            if self.lock_pending().contains_key(&request.id) {
                return Some(request);
            }
        }
    }

    /// The UI's receipt for request `id`: `None` when it navigated, else why not.
    pub fn complete(&self, id: u64, error: Option<String>) {
        if let Some(receipt) = self.lock_pending().remove(&id) {
            let _ = receipt.send(error.map_or(Ok(()), Err));
        }
    }

    pub fn close(&self) {
        self.closed.send_replace(true);
        self.lock_pending().clear();
    }

    async fn navigate(
        &self,
        project_id: String,
        session_path: Option<String>,
    ) -> Result<(), HostApiError> {
        let mut ready = self.ready.subscribe();
        tokio::time::timeout(self.ui_ready_timeout, ready.wait_for(|ready| *ready))
            .await
            .map_err(|_| unavailable("the Pilo window did not become ready to navigate"))?
            .map_err(|_| unavailable("the Pilo window is closing"))?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (receipt, answer) = oneshot::channel();
        self.lock_pending().insert(id, receipt);
        let request = NavigationRequest {
            id,
            project_id,
            session_path,
        };
        if self.sender.send(request).is_err() {
            self.lock_pending().remove(&id);
            return Err(unavailable("the Pilo window is closing"));
        }
        match tokio::time::timeout(self.receipt_timeout, answer).await {
            Ok(Ok(Ok(()))) => Ok(()),
            Ok(Ok(Err(error))) => Err(HostApiError::new(
                ErrorCode::Conflict,
                format!("the Pilo window could not navigate: {error}"),
            )),
            Ok(Err(_)) => Err(unavailable("the Pilo window is closing")),
            Err(_) => {
                self.lock_pending().remove(&id);
                Err(HostApiError::new(
                    ErrorCode::Timeout,
                    "the Pilo window did not confirm the navigation",
                ))
            }
        }
    }

    fn lock_pending(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Receipt>> {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Runtime {
    pub fn navigator(&self) -> Arc<Navigator> {
        self.navigator.clone()
    }
}

fn unavailable(message: &str) -> HostApiError {
    HostApiError::new(ErrorCode::Unavailable, message)
}

fn invalid(message: impl Into<String>) -> HostApiError {
    HostApiError::new(ErrorCode::InvalidParams, message)
}

/// `desktop.open`: shows a Local project directory (added when new) or the
/// session with ID or unique ID prefix `session_id` in the desktop window.
pub(crate) async fn open(
    runtime: &Runtime,
    path: Option<String>,
    session_id: Option<String>,
) -> Result<Value, HostApiError> {
    match (path, session_id) {
        (Some(_), Some(_)) => Err(invalid("pass either a directory or a session ID, not both")),
        (None, None) => Err(invalid("pass a directory or a session ID")),
        (Some(path), None) => open_directory(runtime, path).await,
        (None, Some(id)) => open_session(runtime, id).await,
    }
}

async fn open_directory(runtime: &Runtime, path: String) -> Result<Value, HostApiError> {
    if !Path::new(&path).is_absolute() {
        return Err(invalid(format!(
            "'{path}' is not absolute; resolve it against the caller's working directory"
        )));
    }
    let directory = tokio::fs::canonicalize(&path)
        .await
        .map_err(|error| invalid(format!("cannot open '{path}': {error}")))?;
    if !directory.is_dir() {
        return Err(invalid(format!("'{path}' is not a directory")));
    }
    let projects = load(runtime, project::list).await?;
    let (project, added) = match find_local_project(&projects, &directory) {
        Some(project) => (project.clone(), false),
        None => {
            let project = project_api::project_add(
                runtime,
                "local".to_owned(),
                directory.to_string_lossy().into_owned(),
            )
            .await
            .map_err(invalid)?;
            (project, true)
        }
    };
    runtime.navigator.navigate(project.id.clone(), None).await?;
    Ok(json!({
        "projectId": project.id,
        "project": project.name,
        "path": project.path,
        "added": added,
    }))
}

fn find_local_project<'a>(projects: &'a [Project], directory: &Path) -> Option<&'a Project> {
    projects.iter().find(|project| {
        matches!(project.connection.kind, ConnectionKind::Local)
            && std::fs::canonicalize(&project.path).unwrap_or_else(|_| PathBuf::from(&project.path))
                == directory
    })
}

async fn open_session(runtime: &Runtime, id: String) -> Result<Value, HostApiError> {
    let id = id.trim().to_owned();
    if id.is_empty() {
        return Err(invalid("the session ID is empty"));
    }
    if id.contains(['/', '\\']) || id.ends_with(".jsonl") {
        return Err(invalid(format!(
            "'{id}' looks like a path; pass a session ID or its unique prefix"
        )));
    }
    let candidates = load(runtime, |runtime| {
        let mut sessions = Vec::new();
        for project in project::list(runtime)? {
            for entry in session_api::session_list(runtime, project.id.clone())? {
                sessions.push((project.clone(), entry));
            }
        }
        Ok(sessions)
    })
    .await?;
    let (project, entry) = match_session(candidates, &id)?;
    runtime
        .navigator
        .navigate(project.id.clone(), Some(entry.session_path.clone()))
        .await?;
    Ok(json!({
        "projectId": project.id,
        "project": project.name,
        "path": project.path,
        "sessionId": entry.pi_session_id,
        "sessionPath": entry.session_path,
    }))
}

/// The one session whose ID is `id`, else the one whose ID starts with it.
fn match_session(
    candidates: Vec<(Project, SessionIndexEntry)>,
    id: &str,
) -> Result<(Project, SessionIndexEntry), HostApiError> {
    let (exact, prefixed): (Vec<_>, Vec<_>) = candidates
        .into_iter()
        .filter(|(_, entry)| entry.pi_session_id.starts_with(id))
        .partition(|(_, entry)| entry.pi_session_id == id);
    let mut matches = if exact.is_empty() { prefixed } else { exact };
    match matches.len() {
        0 => Err(HostApiError::new(
            ErrorCode::NotFound,
            format!("no session ID starts with '{id}'"),
        )),
        1 => Ok(matches.remove(0)),
        count => {
            let listed = matches
                .iter()
                .take(MAX_LISTED_CANDIDATES)
                .map(|(project, entry)| {
                    let title = entry.name.as_deref().unwrap_or("untitled");
                    format!("  {} {} ({title})", entry.pi_session_id, project.name)
                })
                .collect::<Vec<_>>()
                .join("\n");
            let more = count.saturating_sub(MAX_LISTED_CANDIDATES);
            let more = if more > 0 {
                format!("\n  … and {more} more")
            } else {
                String::new()
            };
            Err(HostApiError::new(
                ErrorCode::Conflict,
                format!("'{id}' matches {count} sessions; pass a longer prefix:\n{listed}{more}"),
            ))
        }
    }
}

async fn load<T: Send + 'static>(
    runtime: &Runtime,
    task: impl FnOnce(&Runtime) -> Result<T, String> + Send + 'static,
) -> Result<T, HostApiError> {
    let runtime = runtime.clone();
    tokio::task::spawn_blocking(move || task(&runtime))
        .await
        .map_err(|error| HostApiError::new(ErrorCode::Internal, error.to_string()))?
        .map_err(|error| HostApiError::new(ErrorCode::Internal, error))
}

#[cfg(test)]
mod tests;
