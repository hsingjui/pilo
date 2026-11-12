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

#[cfg(windows)]
// Windows does not expose another process's cwd through the standard process
// listing APIs. Read the drive-specific or UNC cwd from a short-lived PowerShell
// probe; keeping this here avoids unsafe Rust and a platform-only native
// dependency in the server crate.
fn external_pi_processes(project: &Path, owned_pids: &HashSet<u32>) -> Vec<ExternalPiProcess> {
    use std::os::windows::process::CommandExt;

    let project = project
        .canonicalize()
        .unwrap_or_else(|_| project.to_path_buf());
    let project_value = project.to_string_lossy().into_owned();
    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            WINDOWS_PROCESS_ACTIVITY_SCRIPT,
        ])
        .env("PILO_ACTIVITY_PROJECT", project_value)
        .creation_flags(0x0800_0000)
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }

    let Ok(stdout) = String::from_utf8(output.stdout) else {
        return Vec::new();
    };
    stdout
        .lines()
        .filter_map(|line| {
            let process = serde_json::from_str::<Value>(line).ok()?;
            let pid = process.get("pid")?.as_u64()? as u32;
            if pid == std::process::id() || owned_pids.contains(&pid) {
                return None;
            }
            let command = process.get("command")?.as_str()?;
            if !looks_like_pi_command(command.as_bytes()) {
                return None;
            }
            let cwd = PathBuf::from(process.get("cwd")?.as_str()?);
            if !windows_paths_equal(&cwd, &project) {
                return None;
            }
            Some(ExternalPiProcess {
                session_path: explicit_session_path(command.as_bytes(), &cwd),
            })
        })
        .collect()
}

#[cfg(windows)]
fn windows_paths_equal(left: &Path, right: &Path) -> bool {
    let left = left.canonicalize().unwrap_or_else(|_| left.to_path_buf());
    let right = right.canonicalize().unwrap_or_else(|_| right.to_path_buf());
    left.to_string_lossy()
        .trim_end_matches(|character| character == '\\' || character == '/')
        .eq_ignore_ascii_case(
            right
                .to_string_lossy()
                .trim_end_matches(|character| character == '\\' || character == '/'),
        )
}

#[cfg(windows)]
const WINDOWS_PROCESS_ACTIVITY_SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class PiloProcessActivity {
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessBasicInformation {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsWow64Process(IntPtr process, out bool wow64Process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadProcessMemory(
        IntPtr process,
        IntPtr address,
        byte[] buffer,
        int size,
        out int bytesRead);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
        IntPtr process,
        int informationClass,
        out ProcessBasicInformation information,
        int informationLength,
        out int returnLength);

    public static string CurrentDirectory(int processId, string project) {
        if (String.IsNullOrEmpty(project)) return null;
        if (project.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase))
            project = "\\\\" + project.Substring(8);
        else if (project.StartsWith("\\\\?\\", StringComparison.Ordinal))
            project = project.Substring(4);
        bool isUnc = project.StartsWith("\\\\", StringComparison.Ordinal);
        if (!isUnc && (project.Length < 2 || project[1] != ':')) return null;

        IntPtr process = OpenProcess(0x1010, false, (uint)processId);
        if (process == IntPtr.Zero) return null;
        try {
            bool wow64;
            if (!IsWow64Process(process, out wow64)) return null;
            if (wow64) return null;

            ProcessBasicInformation information;
            int returnLength;
            if (NtQueryInformationProcess(
                process,
                0,
                out information,
                Marshal.SizeOf<ProcessBasicInformation>(),
                out returnLength) != 0) return null;

            int pointerSize = IntPtr.Size;
            IntPtr parameters = ReadPointer(
                process,
                Add(information.PebBaseAddress, pointerSize == 8 ? 0x20 : 0x10),
                pointerSize);
            if (parameters == IntPtr.Zero) return null;
            if (isUnc)
                return ReadCurrentDirectory(process, parameters, pointerSize);

            IntPtr environment = ReadPointer(
                process,
                Add(parameters, pointerSize == 8 ? 0x80 : 0x48),
                pointerSize);
            if (environment != IntPtr.Zero) {
                byte[] buffer = new byte[64 * 1024];
                int bytesRead;
                if (ReadProcessMemory(process, environment, buffer, buffer.Length, out bytesRead)) {
                    string block = Encoding.Unicode.GetString(buffer, 0, bytesRead);
                    string prefix = "=" + Char.ToUpperInvariant(project[0]) + ":";
                    foreach (string entry in block.Split('\0')) {
                        if (entry.StartsWith(prefix + "=", StringComparison.OrdinalIgnoreCase))
                            return entry.Substring(prefix.Length + 1);
                    }
                }
            }
            return ReadDriveDirectory(process, parameters, pointerSize, project[0]);
        } finally {
            CloseHandle(process);
        }
    }

    private static string ReadCurrentDirectory(
        IntPtr process,
        IntPtr parameters,
        int pointerSize) {
        IntPtr currentDirectory = Add(parameters, pointerSize == 8 ? 0x38 : 0x24);
        return ReadUnicodeString(process, Add(currentDirectory, pointerSize), pointerSize);
    }

    private static string ReadDriveDirectory(
        IntPtr process,
        IntPtr parameters,
        int pointerSize,
        char driveLetter) {
        int drive = Char.ToUpperInvariant(driveLetter) - 'A';
        if (drive < 0 || drive >= 26) return null;
        int directorySize = pointerSize == 8 ? 0x18 : 0x10;
        int directoriesOffset = pointerSize == 8 ? 0xf0 : 0x90;
        IntPtr directory = Add(
            Add(parameters, directoriesOffset),
            drive * directorySize);
        return ReadUnicodeString(process, Add(directory, 8), pointerSize);
    }

    private static string ReadUnicodeString(
        IntPtr process,
        IntPtr unicodeString,
        int pointerSize) {
        byte[] lengthBuffer = new byte[2];
        int bytesRead;
        if (!ReadProcessMemory(process, unicodeString, lengthBuffer, 2, out bytesRead)
            || bytesRead != 2) return null;
        int length = BitConverter.ToUInt16(lengthBuffer, 0);
        if (length == 0) return null;
        IntPtr buffer = ReadPointer(process, Add(unicodeString, pointerSize), pointerSize);
        if (buffer == IntPtr.Zero) return null;
        byte[] path = new byte[length];
        if (!ReadProcessMemory(process, buffer, path, length, out bytesRead)
            || bytesRead != length) return null;
        return Encoding.Unicode.GetString(path);
    }

    private static IntPtr ReadPointer(IntPtr process, IntPtr address, int pointerSize) {
        byte[] buffer = new byte[pointerSize];
        int bytesRead;
        if (!ReadProcessMemory(process, address, buffer, pointerSize, out bytesRead)
            || bytesRead != pointerSize) return IntPtr.Zero;
        return pointerSize == 8
            ? new IntPtr(BitConverter.ToInt64(buffer, 0))
            : new IntPtr(BitConverter.ToInt32(buffer, 0));
    }

    private static IntPtr Add(IntPtr address, int offset) {
        return new IntPtr(address.ToInt64() + offset);
    }
}
'@
Get-CimInstance Win32_Process | ForEach-Object {
    if ($_.ProcessId -eq $PID -or [String]::IsNullOrEmpty($_.CommandLine)) { return }
    $cwd = [PiloProcessActivity]::CurrentDirectory(
        [int]$_.ProcessId,
        $env:PILO_ACTIVITY_PROJECT)
    if (-not [String]::IsNullOrEmpty($cwd)) {
        [PSCustomObject]@{
            pid = [int]$_.ProcessId
            cwd = $cwd
            command = $_.CommandLine
        } | ConvertTo-Json -Compress
    }
}
"#;

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
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

#[cfg(windows)]
fn command_args(command: &[u8]) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = Vec::new();
    let mut in_quotes = false;
    let mut backslashes = 0;

    let push_backslashes = |current: &mut Vec<u8>, count: usize| {
        current.extend(std::iter::repeat(b'\\').take(count));
    };
    let push_argument = |args: &mut Vec<String>, current: &mut Vec<u8>| {
        if !current.is_empty() {
            args.push(String::from_utf8_lossy(current).into_owned());
            current.clear();
        }
    };

    let mut index = 0;
    while index < command.len() {
        let byte = command[index];
        if byte == b'\\' {
            backslashes += 1;
            index += 1;
            continue;
        }
        if byte == b'"' {
            push_backslashes(&mut current, backslashes / 2);
            if backslashes % 2 == 1 {
                current.push(b'"');
            } else {
                in_quotes = !in_quotes;
            }
            backslashes = 0;
            index += 1;
            continue;
        }

        push_backslashes(&mut current, backslashes);
        backslashes = 0;
        if byte.is_ascii_whitespace() && !in_quotes {
            push_argument(&mut args, &mut current);
        } else {
            current.push(byte);
        }
        index += 1;
    }
    push_backslashes(&mut current, backslashes);
    push_argument(&mut args, &mut current);
    args
}

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
fn explicit_session_path(command: &[u8], cwd: &Path) -> Option<PathBuf> {
    let args = command_args(command);
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

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
fn looks_like_pi_command(command: &[u8]) -> bool {
    let args = command_args(command)
        .into_iter()
        .map(|arg| arg.replace('\\', "/"))
        .collect::<Vec<_>>();
    args.iter().any(|arg| {
        let lower = arg.to_ascii_lowercase();
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
