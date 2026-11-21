use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::SystemTime,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{agent_dir, session_dir_key};
use crate::to_value;

/// Freshness is only a fallback heuristic when no process names the session.
/// Pi persists completed messages, not streaming deltas: a confirmed live owner
/// can run long model requests or tools without changing the JSONL mtime.
const OPEN_TURN_STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(60);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionActivityParams {
    project: String,
    #[serde(default)]
    owned_session_paths: Vec<String>,
    /// Only observational callers may reuse a process snapshot.
    #[serde(default)]
    allow_cached_processes: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionActivity {
    path: String,
    turn_open: bool,
}

pub(crate) fn session_activity(
    params: SessionActivityParams,
    owned_pids: HashSet<u32>,
) -> Result<Value, String> {
    let project = PathBuf::from(params.project.trim());
    let processes = external_pi_processes(&project, &owned_pids, params.allow_cached_processes);
    if processes.is_empty() {
        return to_value(Vec::<SessionActivity>::new());
    }
    let Some(root) = agent_dir().map(|root| {
        root.join("sessions")
            .join(session_dir_key(params.project.trim()))
    }) else {
        return to_value(Vec::<SessionActivity>::new());
    };
    let owned_paths = params
        .owned_session_paths
        .into_iter()
        .map(PathBuf::from)
        .collect::<HashSet<_>>();

    let explicit_paths = processes
        .iter()
        .filter_map(|process| process.session_path.as_ref())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("jsonl"))
        .filter(|path| path.is_file() && !owned_paths.contains(*path))
        .cloned()
        .collect::<HashSet<_>>();

    let fallback_count = processes
        .iter()
        .filter(|process| process.session_path.is_none())
        .count();
    let mut fallback_paths = Vec::new();
    if fallback_count > 0 {
        let Ok(entries) = std::fs::read_dir(&root) else {
            return activities_for_paths(explicit_paths.clone(), &explicit_paths);
        };
        let mut candidates = entries
            .flatten()
            .filter_map(|entry| {
                let path = entry.path();
                if path.extension().and_then(|value| value.to_str()) != Some("jsonl")
                    || owned_paths.contains(&path)
                    || explicit_paths.contains(&path)
                {
                    return None;
                }
                let modified = entry.metadata().ok()?.modified().ok()?;
                Some((modified, path))
            })
            .collect::<Vec<_>>();
        candidates.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));
        fallback_paths.extend(
            candidates
                .into_iter()
                .take(fallback_count)
                .map(|(_, path)| path),
        );
    }

    activities_for_paths(
        explicit_paths
            .iter()
            .cloned()
            .chain(fallback_paths)
            .collect(),
        &explicit_paths,
    )
}

fn activities_for_paths(
    paths: HashSet<PathBuf>,
    confirmed_paths: &HashSet<PathBuf>,
) -> Result<Value, String> {
    let mut paths = paths.into_iter().collect::<Vec<_>>();
    paths.sort();
    to_value(
        paths
            .into_iter()
            .map(|path| SessionActivity {
                path: path.to_string_lossy().into_owned(),
                turn_open: if confirmed_paths.contains(&path) {
                    session_tail_turn_open(&path)
                } else {
                    session_turn_open(&path)
                },
            })
            .collect::<Vec<_>>(),
    )
}

fn session_turn_open(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    // A project-matched process alone cannot prove it owns this inferred file.
    // Keep stale abandoned tails out of the fallback candidate activity.
    if metadata
        .modified()
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_none_or(|age| age >= OPEN_TURN_STALE_AFTER)
    {
        return false;
    }
    session_tail_turn_open(path)
}

#[derive(Deserialize)]
struct SessionTailMessage {
    role: String,
    #[serde(rename = "stopReason")]
    stop_reason: Option<String>,
}

#[derive(Deserialize)]
struct SessionTailEntry {
    #[serde(rename = "type")]
    kind: String,
    message: Option<SessionTailMessage>,
}

fn session_tail_turn_open(path: &Path) -> bool {
    use std::io::{BufReader, Read as _, Seek as _, SeekFrom};
    // The line lookup starts small so a short trailing entry costs one small read,
    // and doubles only while a single entry is longer than the current window.
    const MIN_CHUNK_BYTES: u64 = 4 * 1024;
    const MAX_CHUNK_BYTES: u64 = 128 * 1024;
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let Ok(size) = file.metadata().map(|metadata| metadata.len()) else {
        return false;
    };
    if size == 0 {
        return false;
    }
    let mut bytes = vec![0; size.min(MAX_CHUNK_BYTES) as usize];
    let mut end = size;
    // Locate complete lines backwards, then deserialize only role/stopReason.
    // Large text/image messages must not turn a completed session into "unknown".
    while end > 0 {
        let mut start = end;
        let mut window = MIN_CHUNK_BYTES;
        loop {
            let chunk_start = start.saturating_sub(window);
            let length = (start - chunk_start) as usize;
            if file.seek(SeekFrom::Start(chunk_start)).is_err()
                || file.read_exact(&mut bytes[..length]).is_err()
            {
                return false;
            }
            if let Some(newline) = bytes[..length].iter().rposition(|byte| *byte == b'\n') {
                start = chunk_start + newline as u64 + 1;
                break;
            }
            start = chunk_start;
            if start == 0 {
                break;
            }
            window = (window * 2).min(MAX_CHUNK_BYTES);
        }
        if start < end {
            if file.seek(SeekFrom::Start(start)).is_err() {
                return false;
            }
            if let Ok(entry) = serde_json::from_reader::<_, SessionTailEntry>(BufReader::new(
                (&mut file).take(end - start),
            )) && entry.kind == "message"
                && let Some(message) = entry.message
            {
                match message.role.as_str() {
                    "user" | "toolResult" => return true,
                    "assistant" => {
                        return !matches!(
                            message.stop_reason.as_deref(),
                            Some("stop" | "length" | "error" | "aborted")
                        );
                    }
                    _ => {}
                }
            }
        }
        if start == 0 {
            break;
        }
        end = start - 1;
    }
    // No `message` entry anywhere yet (for example a session file that so far only
    // holds its header). A live process names this file, so prefer "active" over
    // reporting a running external session as idle and takeable.
    true
}

#[derive(Debug)]
struct ExternalPiProcess {
    session_path: Option<PathBuf>,
}

/// How long one process enumeration answers `session.activity` calls. A poll
/// or a burst of file changes asks once per project; they share one scan.
const PI_PROCESS_SNAPSHOT_TTL: std::time::Duration = std::time::Duration::from_secs(1);

/// A Pi-shaped process as last enumerated, before the per-call project and
/// ownership filters.
struct PiProcessEntry {
    /// The process and its ancestors, innermost first. Pilo owns its Pi
    /// process tree, not only the direct child: Windows starts Pi through a
    /// `pi.cmd` launcher whose node descendants are the real agent.
    lineage: Vec<u32>,
    args: Vec<String>,
    cwd: PathBuf,
}

struct PiProcessSnapshot {
    taken_at: std::time::Instant,
    /// Pilo's processes when taken: one that started or exited since must not
    /// be judged from an older process list.
    owned_pids: HashSet<u32>,
    entries: Vec<PiProcessEntry>,
}

/// Lists Pi processes running in `project` that Pilo does not own. Callers
/// doing an ownership check always enumerate; observational calls may reuse
/// the latest snapshot within [`PI_PROCESS_SNAPSHOT_TTL`].
fn external_pi_processes(
    project: &Path,
    owned_pids: &HashSet<u32>,
    allow_cached_processes: bool,
) -> Vec<ExternalPiProcess> {
    static SNAPSHOT: std::sync::Mutex<Option<PiProcessSnapshot>> = std::sync::Mutex::new(None);

    let project = project
        .canonicalize()
        .unwrap_or_else(|_| project.to_path_buf());
    let mut snapshot = SNAPSHOT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let reuse = allow_cached_processes
        && snapshot.as_ref().is_some_and(|snapshot| {
            snapshot.taken_at.elapsed() < PI_PROCESS_SNAPSHOT_TTL
                && snapshot.owned_pids == *owned_pids
        });
    if !reuse {
        *snapshot = Some(PiProcessSnapshot {
            taken_at: std::time::Instant::now(),
            owned_pids: owned_pids.clone(),
            entries: pi_process_entries(),
        });
    }
    snapshot
        .as_ref()
        .map(|snapshot| snapshot.entries.as_slice())
        .unwrap_or_default()
        .iter()
        .filter(|entry| !entry.lineage.iter().any(|pid| owned_pids.contains(pid)))
        .filter(|entry| same_project_path(&entry.cwd, &project))
        .map(|entry| ExternalPiProcess {
            session_path: explicit_session_path(&entry.args, &entry.cwd),
        })
        .collect()
}

/// Enumerates the Pi agents on this machine, other than this server.
///
/// Command lines are read for every process (microseconds each); the cwd is
/// read only for Pi-shaped candidates. A fresh `System` per scan keeps no
/// process handles open between polls and cannot confuse reused PIDs.
fn pi_process_entries() -> Vec<PiProcessEntry> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

    let Ok(mut system) = System::new() else {
        return Vec::new();
    };
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .without_tasks()
            .with_cmd(UpdateKind::Always),
    );
    let server_pid = std::process::id();
    let processes = system.processes();
    let pi_processes = processes
        .values()
        .filter(|process| process.thread_kind().is_none())
        .filter(|process| looks_like_pi_command(&command_args(process.cmd())))
        .collect::<Vec<_>>();
    let pi_pids = pi_processes
        .iter()
        .map(|process| process.pid())
        .collect::<HashSet<_>>();
    // Launchers (`pi.cmd`, version-manager shims) form a chain of Pi-shaped
    // processes for one agent; count only the innermost so one agent is one
    // fallback candidate. A shell in between marks a separately started Pi.
    // Explicit `--session` paths always count: they deduplicate by path, and a
    // Pi-shaped tool command must not hide its agent's session.
    let launchers = pi_processes
        .iter()
        .flat_map(|process| {
            ancestors(processes, process)
                .take_while(|ancestor| pi_pids.contains(&ancestor.pid()))
                .map(sysinfo::Process::pid)
        })
        .collect::<HashSet<_>>();
    let candidates = pi_processes
        .into_iter()
        .filter(|process| process.pid().as_u32() != server_pid)
        .filter(|process| {
            !launchers.contains(&process.pid())
                || explicit_session_path(&command_args(process.cmd()), Path::new("")).is_some()
        })
        .map(|process| {
            let lineage = std::iter::once(process)
                .chain(ancestors(processes, process))
                .map(|process| process.pid().as_u32())
                .collect::<Vec<_>>();
            (process.pid(), lineage)
        })
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return Vec::new();
    }
    let pids = candidates.iter().map(|(pid, _)| *pid).collect::<Vec<_>>();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pids),
        false,
        ProcessRefreshKind::nothing()
            .without_tasks()
            .with_cwd(UpdateKind::Always),
    );
    candidates
        .into_iter()
        .filter_map(|(pid, lineage)| {
            let process = system.process(pid)?;
            let cwd = process.cwd()?;
            Some(PiProcessEntry {
                lineage,
                args: command_args(process.cmd()),
                cwd: cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf()),
            })
        })
        .collect()
}

type ProcessMap = std::collections::HashMap<sysinfo::Pid, sysinfo::Process>;

fn ancestors<'a>(
    processes: &'a ProcessMap,
    process: &'a sysinfo::Process,
) -> impl Iterator<Item = &'a sysinfo::Process> {
    const MAX_ANCESTORS: usize = 64;
    let mut current = process;
    std::iter::from_fn(move || {
        let parent = processes.get(&current.parent()?)?;
        // A parent that started after its child is an unrelated reused PID.
        if parent.start_time() > current.start_time() {
            return None;
        }
        current = parent;
        Some(parent)
    })
    .take(MAX_ANCESTORS)
}

#[cfg(windows)]
fn same_project_path(cwd: &Path, project: &Path) -> bool {
    cwd.to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .eq_ignore_ascii_case(project.to_string_lossy().trim_end_matches(['\\', '/']))
}

#[cfg(not(windows))]
fn same_project_path(cwd: &Path, project: &Path) -> bool {
    cwd == project
}

fn command_args(command: &[std::ffi::OsString]) -> Vec<String> {
    command
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect()
}

fn explicit_session_path(args: &[String], cwd: &Path) -> Option<PathBuf> {
    let value = args.windows(2).find_map(|window| {
        (window[0] == "--session" || window[0] == "-s").then(|| window[1].trim_matches(['"', '\'']))
    })?;
    let candidate = PathBuf::from(value);
    if candidate.extension().and_then(|value| value.to_str()) != Some("jsonl") {
        return None;
    }
    Some(if candidate.is_absolute() {
        candidate
    } else {
        cwd.join(candidate)
    })
}

fn looks_like_pi_command(args: &[String]) -> bool {
    args.iter().any(|arg| {
        let lower = arg.replace('\\', "/").to_ascii_lowercase();
        lower.ends_with("/pi")
            || lower.ends_with("/pi.exe")
            || lower.ends_with("/pi.cmd")
            || lower.ends_with("/pi.bat")
            || matches!(lower.as_str(), "pi" | "pi.exe" | "pi.cmd" | "pi.bat")
            || lower.contains("/pi-coding-agent/")
            || lower.ends_with("/dist/bundle/cli.js")
    })
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod tests {
    use std::path::{Path, PathBuf};

    use super::{OPEN_TURN_STALE_AFTER, explicit_session_path, looks_like_pi_command};

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn recognizes_pi_cli_shapes() {
        assert!(looks_like_pi_command(&args(&[
            "/usr/bin/node",
            "/x/pi-coding-agent/dist/bundle/cli.js"
        ])));
        assert!(looks_like_pi_command(&args(&[
            "/home/u/.local/bin/pi",
            "--session",
            "/tmp/a.jsonl"
        ])));
        assert!(looks_like_pi_command(&args(&[
            "C:\\Users\\u\\AppData\\Local\\pnpm\\pi.CMD"
        ])));
        assert!(!looks_like_pi_command(&args(&[
            "/usr/bin/node",
            "server.js"
        ])));
    }

    #[test]
    fn extracts_explicit_session_path() {
        assert_eq!(
            explicit_session_path(
                &args(&["pi", "--session", "/tmp/a.jsonl"]),
                Path::new("/work")
            ),
            Some(PathBuf::from("/tmp/a.jsonl"))
        );
        assert_eq!(
            explicit_session_path(&args(&["pi", "-s", "relative/a.jsonl"]), Path::new("/work")),
            Some(PathBuf::from("/work/relative/a.jsonl"))
        );
        assert_eq!(
            explicit_session_path(
                &args(&["pi", "--session", "session-id"]),
                Path::new("/work")
            ),
            None
        );
    }

    #[test]
    fn stale_unterminated_tail_is_not_an_open_turn() {
        let dir = std::env::temp_dir().join(format!("pilo-activity-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("stale-session.jsonl");
        std::fs::write(
            &path,
            "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"toolUse\"}}\n",
        )
        .unwrap();
        // Backdate the file so the freshness window has expired.
        let stale = std::time::SystemTime::now()
            - std::time::Duration::from_secs(OPEN_TURN_STALE_AFTER.as_secs() + 60);
        let file = std::fs::File::options().write(true).open(&path).unwrap();
        file.set_modified(stale).unwrap();
        drop(file);
        assert!(!super::session_turn_open(&path));

        // A fresh unterminated tail still counts as an open turn.
        let fresh = dir.join("fresh-session.jsonl");
        std::fs::write(
            &fresh,
            "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"toolUse\"}}\n",
        )
        .unwrap();
        assert!(super::session_turn_open(&fresh));

        // A stale file with a terminal stopReason stays closed regardless.
        let closed = dir.join("closed-session.jsonl");
        std::fs::write(
            &closed,
            "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"stop\"}}\n",
        )
        .unwrap();
        let closed_file = std::fs::File::options().write(true).open(&closed).unwrap();
        closed_file.set_modified(stale).unwrap();
        drop(closed_file);
        assert!(!super::session_turn_open(&closed));

        std::fs::remove_dir_all(&dir).ok();
    }
}
