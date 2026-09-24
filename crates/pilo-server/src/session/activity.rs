use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::SystemTime,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{agent_dir, session_dir_key};
use crate::to_value;

/// Unterminated tails older than this are treated as crashed turns, not live ones.
/// Pi appends to the session JSONL throughout a turn (deltas, tool calls), so any
/// genuinely running turn refreshes mtime well inside this window.
const OPEN_TURN_STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(60);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionActivityParams {
    project: String,
    #[serde(default)]
    owned_session_paths: Vec<String>,
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
    let processes = external_pi_processes(&project, &owned_pids);
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
            return activities_for_paths(explicit_paths);
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

    activities_for_paths(explicit_paths.into_iter().chain(fallback_paths).collect())
}

fn activities_for_paths(paths: HashSet<PathBuf>) -> Result<Value, String> {
    let mut paths = paths.into_iter().collect::<Vec<_>>();
    paths.sort();
    to_value(
        paths
            .into_iter()
            .map(|path| SessionActivity {
                path: path.to_string_lossy().into_owned(),
                turn_open: session_turn_open(&path),
            })
            .collect::<Vec<_>>(),
    )
}

fn session_turn_open(path: &Path) -> bool {
    use std::io::{Read as _, Seek as _, SeekFrom};
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    // A turn left open (assistant `toolUse` / missing terminal stopReason) is
    // only evidence of a live turn if the file was written recently. A crashed
    // or killed external Pi leaves an unterminated tail behind; without this
    // freshness check the session would look "running" forever.
    if metadata
        .modified()
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_none_or(|age| age >= OPEN_TURN_STALE_AFTER)
    {
        return false;
    }
    const TAIL_BYTES: u64 = 128 * 1024;
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let Ok(size) = file.metadata().map(|metadata| metadata.len()) else {
        return false;
    };
    let start = size.saturating_sub(TAIL_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return false;
    }
    let mut bytes = Vec::with_capacity((size - start) as usize);
    if file.read_to_end(&mut bytes).is_err() {
        return false;
    }
    let mut lines = bytes.split(|byte| *byte == b'\n');
    if start > 0 {
        let _ = lines.next();
    }
    let mut last_message: Option<Value> = None;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        if entry.get("type").and_then(Value::as_str) == Some("message") {
            last_message = entry.get("message").cloned();
        }
    }
    let Some(message) = last_message else {
        // A very large final JSONL message can begin before the bounded tail.
        // While an external Pi process still owns the session, prefer treating
        // an unreadable non-empty tail as live rather than falsely showing an
        // interrupted turn. Process exit will clear observer mode.
        return size > 0;
    };
    match message.get("role").and_then(Value::as_str) {
        Some("user" | "toolResult") => true,
        Some("assistant") => !matches!(
            message.get("stopReason").and_then(Value::as_str),
            Some("stop" | "length" | "error" | "aborted")
        ),
        _ => false,
    }
}

#[derive(Debug)]
struct ExternalPiProcess {
    session_path: Option<PathBuf>,
}

#[cfg(target_os = "linux")]
fn external_pi_processes(project: &Path, owned_pids: &HashSet<u32>) -> Vec<ExternalPiProcess> {
    let project = project
        .canonicalize()
        .unwrap_or_else(|_| project.to_path_buf());
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| entry.file_name().to_string_lossy().parse::<u32>().ok())
        .filter(|pid| *pid != std::process::id() && !owned_pids.contains(pid))
        .filter_map(|pid| {
            let cwd = std::fs::read_link(format!("/proc/{pid}/cwd"))
                .ok()
                .and_then(|cwd| cwd.canonicalize().ok().or(Some(cwd)))?;
            if cwd != project {
                return None;
            }
            let command = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
            if !looks_like_pi_command(&command) {
                return None;
            }
            Some(ExternalPiProcess {
                session_path: explicit_session_path(&command, &cwd),
            })
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn external_pi_processes(project: &Path, owned_pids: &HashSet<u32>) -> Vec<ExternalPiProcess> {
    let project = project
        .canonicalize()
        .unwrap_or_else(|_| project.to_path_buf());
    let Ok(output) = std::process::Command::new("/bin/ps")
        .args(["-axww", "-o", "pid=,command="])
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line
                .trim_start()
                .splitn(2, |character: char| character.is_ascii_whitespace());
            let pid = fields.next()?.parse::<u32>().ok()?;
            if pid == std::process::id() || owned_pids.contains(&pid) {
                return None;
            }
            let command = fields.next()?.trim();
            if !looks_like_pi_command(command.as_bytes()) {
                return None;
            }
            let cwd = macos_process_cwd(pid)?;
            let cwd = cwd.canonicalize().unwrap_or(cwd);
            if cwd != project {
                return None;
            }
            Some(ExternalPiProcess {
                session_path: explicit_session_path(command.as_bytes(), &cwd),
            })
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn macos_process_cwd(pid: u32) -> Option<PathBuf> {
    let pid = pid.to_string();
    let output = std::process::Command::new("/usr/sbin/lsof")
        .args(["-a", "-p", &pid, "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| {
            line.strip_prefix('n')
                .filter(|path| !path.is_empty())
                .map(PathBuf::from)
        })
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn external_pi_processes(_project: &Path, _owned_pids: &HashSet<u32>) -> Vec<ExternalPiProcess> {
    Vec::new()
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn command_args(command: &[u8]) -> Vec<String> {
    if command.contains(&0) {
        return command
            .split(|byte| *byte == 0)
            .filter(|arg| !arg.is_empty())
            .map(|arg| String::from_utf8_lossy(arg).into_owned())
            .collect();
    }
    command
        .split(|byte| byte.is_ascii_whitespace())
        .filter(|arg| !arg.is_empty())
        .map(|arg| String::from_utf8_lossy(arg).into_owned())
        .collect()
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn explicit_session_path(command: &[u8], cwd: &Path) -> Option<PathBuf> {
    let args = command_args(command);
    let value = args.windows(2).find_map(|window| {
        (window[0] == "--session" || window[0] == "-s").then(|| window[1].as_str())
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

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn looks_like_pi_command(command: &[u8]) -> bool {
    let args = command_args(command)
        .into_iter()
        .map(|arg| arg.replace('\\', "/"))
        .collect::<Vec<_>>();
    args.iter().any(|arg| {
        let lower = arg.to_ascii_lowercase();
        lower.ends_with("/pi")
            || lower == "pi"
            || lower.contains("/pi-coding-agent/")
            || lower.ends_with("/dist/bundle/cli.js")
    })
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod tests {
    use std::path::{Path, PathBuf};

    use super::{OPEN_TURN_STALE_AFTER, explicit_session_path, looks_like_pi_command};

    #[test]
    fn recognizes_pi_cli_shapes() {
        assert!(looks_like_pi_command(
            b"/usr/bin/node\0/x/pi-coding-agent/dist/bundle/cli.js\0"
        ));
        assert!(looks_like_pi_command(
            b"/home/u/.local/bin/pi\0--session\0/tmp/a.jsonl\0"
        ));
        assert!(looks_like_pi_command(
            b"/opt/homebrew/bin/node /Users/u/.pi/agent/node_modules/pi-coding-agent/dist/bundle/cli.js --mode rpc"
        ));
        assert!(!looks_like_pi_command(b"/usr/bin/node\0server.js\0"));
    }

    #[test]
    fn extracts_explicit_session_path() {
        assert_eq!(
            explicit_session_path(b"pi\0--session\0/tmp/a.jsonl\0", Path::new("/work")),
            Some(PathBuf::from("/tmp/a.jsonl"))
        );
        assert_eq!(
            explicit_session_path(b"pi\0-s\0relative/a.jsonl\0", Path::new("/work")),
            Some(PathBuf::from("/work/relative/a.jsonl"))
        );
        assert_eq!(
            explicit_session_path(b"pi --session /tmp/a.jsonl", Path::new("/work")),
            Some(PathBuf::from("/tmp/a.jsonl"))
        );
        assert_eq!(
            explicit_session_path(b"pi\0--session\0session-id\0", Path::new("/work")),
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
