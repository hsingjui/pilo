use std::{
    io::{Read, Write},
    path::Path,
    sync::Arc,
};

use pilo_protocol::Envelope;
use portable_pty::{Child as PtyChild, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::environment::{cached_login_path, default_shell_in_path};
use crate::session::windows_verbatim_path;
use crate::{ServerState, blocking};

pub(crate) struct TerminalSession {
    pub(crate) master: Box<dyn MasterPty + Send>,
    pub(crate) writer: Box<dyn Write + Send>,
    pub(crate) child: Box<dyn PtyChild + Send + Sync>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalOpenParams {
    stream_id: String,
    project: String,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalWriteParams {
    stream_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalResizeParams {
    stream_id: String,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalCloseParams {
    stream_id: String,
}

pub(crate) async fn terminal_open(
    state: &ServerState,
    params: TerminalOpenParams,
) -> Result<Value, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: params.rows.max(1),
            cols: params.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("failed to open terminal PTY: {error}"))?;

    let path = cached_login_path(state).await;
    let shell = default_shell_in_path(&path);
    let command = build_terminal_command(&shell, &params.project, &path);
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("failed to start terminal: {error}"))?;
    drop(pair.slave);
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("failed to open terminal reader: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("failed to open terminal writer: {error}"))?;

    let stream_id = params.stream_id;
    {
        let mut terminals = state
            .terminals
            .lock()
            .map_err(|_| "terminal registry is poisoned".to_owned())?;
        if let Some(mut previous) = terminals.remove(&stream_id) {
            let _ = previous.child.kill();
            let _ = previous.child.wait();
        }
        terminals.insert(
            stream_id.clone(),
            TerminalSession {
                master: pair.master,
                writer,
                child,
            },
        );
    }

    let event_stream_id = stream_id.clone();
    let event_writer = state.writer.clone();
    let terminals = Arc::clone(&state.terminals);
    if let Err(error) = std::thread::Builder::new()
        .name(format!("pilo-{stream_id}-reader"))
        .spawn(move || {
            let mut buffer = [0_u8; 16 * 1024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => {
                        let _ = event_writer.blocking_send(Envelope::event(
                            event_stream_id.clone(),
                            "terminal.exit",
                            Value::Null,
                        ));
                        break;
                    }
                    Ok(read) => {
                        if event_writer
                            .blocking_send(Envelope::event_with_binary(
                                event_stream_id.clone(),
                                "terminal.output",
                                Value::Null,
                                vec![buffer[..read].to_vec()],
                            ))
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = event_writer.blocking_send(Envelope::event(
                            event_stream_id.clone(),
                            "terminal.error",
                            json!({ "message": error.to_string() }),
                        ));
                        break;
                    }
                }
            }
            if let Ok(mut terminals) = terminals.lock()
                && let Some(mut terminal) = terminals.remove(&event_stream_id)
            {
                let _ = terminal.child.kill();
                let _ = terminal.child.wait();
            }
        })
    {
        if let Ok(mut terminals) = state.terminals.lock()
            && let Some(mut terminal) = terminals.remove(&stream_id)
        {
            let _ = terminal.child.kill();
            let _ = terminal.child.wait();
        }
        return Err(format!("failed to start terminal reader: {error}"));
    }
    Ok(Value::Null)
}

#[cfg(any(windows, test))]
const WINDOWS_POWERSHELL_UTF8_INIT: &str = "[Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding";

fn build_terminal_command(shell: &str, project: &str, path: &str) -> CommandBuilder {
    let mut command = CommandBuilder::new(shell);
    #[cfg(windows)]
    command.args(windows_shell_args(shell));
    set_project_cwd(&mut command, project);
    command.env("PATH", path);
    if std::env::var_os("TERM").is_none_or(|value| value.is_empty()) {
        command.env("TERM", "xterm-256color");
    }
    if std::env::var_os("COLORTERM").is_none_or(|value| value.is_empty()) {
        command.env("COLORTERM", "truecolor");
    }
    command
}

#[cfg(any(windows, test))]
fn windows_shell_args(shell: &str) -> &'static [&'static str] {
    let executable = shell
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(shell)
        .trim_matches('"')
        .to_ascii_lowercase();
    match executable.as_str() {
        // Keep user profiles enabled (no -NoProfile) while aligning ConPTY console
        // I/O and pipeline encoding with the UTF-8 terminal emulator.
        "pwsh" | "pwsh.exe" | "powershell" | "powershell.exe" => &[
            "-NoLogo",
            "-NoExit",
            "-Command",
            WINDOWS_POWERSHELL_UTF8_INIT,
        ],
        // Keep AutoRun enabled (no /D) when falling back to cmd.exe.
        "cmd" | "cmd.exe" => &["/K", "chcp 65001>NUL"],
        _ => &[],
    }
}

/// `fs::canonicalize` 在 Windows 上给出 `\\?\E:\...`，`cmd.exe` 会把它当成 UNC 路径并
/// 回退到 Windows 目录，终端就在错误的目录里启动。PTY 的 cwd 必须先去掉 verbatim
/// 前缀；UNC 形式还原为 `\\server\share`，普通路径（含 POSIX 路径）原样保留。
fn set_project_cwd(command: &mut CommandBuilder, project: &str) {
    command.cwd(Path::new(&*windows_verbatim_path(project)));
}

pub(crate) async fn terminal_write(
    state: &ServerState,
    params: TerminalWriteParams,
    data: Vec<u8>,
) -> Result<Value, String> {
    let terminals = Arc::clone(&state.terminals);
    blocking(move || {
        let mut terminals = terminals
            .lock()
            .map_err(|_| "terminal registry is poisoned".to_owned())?;
        let terminal = terminals
            .get_mut(&params.stream_id)
            .ok_or_else(|| format!("terminal '{}' is not running", params.stream_id))?;
        terminal
            .writer
            .write_all(&data)
            .and_then(|_| terminal.writer.flush())
            .map_err(|error| format!("failed to write terminal '{}': {error}", params.stream_id))?;
        Ok(Value::Null)
    })
    .await
}

pub(crate) async fn terminal_resize(
    state: &ServerState,
    params: TerminalResizeParams,
) -> Result<Value, String> {
    let terminals = Arc::clone(&state.terminals);
    blocking(move || {
        let terminals = terminals
            .lock()
            .map_err(|_| "terminal registry is poisoned".to_owned())?;
        let terminal = terminals
            .get(&params.stream_id)
            .ok_or_else(|| format!("terminal '{}' is not running", params.stream_id))?;
        terminal
            .master
            .resize(PtySize {
                rows: params.rows.max(1),
                cols: params.cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| {
                format!("failed to resize terminal '{}': {error}", params.stream_id)
            })?;
        Ok(Value::Null)
    })
    .await
}

pub(crate) async fn terminal_close(
    state: &ServerState,
    params: TerminalCloseParams,
) -> Result<Value, String> {
    let terminals = Arc::clone(&state.terminals);
    blocking(move || {
        let Some(mut terminal) = terminals
            .lock()
            .map_err(|_| "terminal registry is poisoned".to_owned())?
            .remove(&params.stream_id)
        else {
            return Ok(Value::Null);
        };
        terminal
            .child
            .kill()
            .map_err(|error| format!("failed to stop terminal '{}': {error}", params.stream_id))?;
        let _ = terminal.child.wait();
        Ok(Value::Null)
    })
    .await
}

#[cfg(test)]
mod tests {
    use portable_pty::CommandBuilder;

    use super::{WINDOWS_POWERSHELL_UTF8_INIT, set_project_cwd, windows_shell_args};

    fn resolved_cwd(project: &str) -> Option<String> {
        let mut command = CommandBuilder::new("terminal-cwd-test");
        set_project_cwd(&mut command, project);
        command
            .get_cwd()
            .map(|value| value.to_string_lossy().into_owned())
    }

    #[test]
    fn terminal_cwd_drops_the_verbatim_prefix() {
        for (project, expected) in [
            (r"\\?\E:\my_projects\pilo", r"E:\my_projects\pilo"),
            (r"\\?\C:\Users\测试 用户\code", r"C:\Users\测试 用户\code"),
            (
                r"\\?\UNC\server\shared folder\code",
                r"\\server\shared folder\code",
            ),
        ] {
            assert_eq!(
                resolved_cwd(project).as_deref(),
                Some(expected),
                "project={project}"
            );
        }
    }

    #[test]
    fn terminal_cwd_keeps_paths_that_are_already_usable() {
        for project in [r"E:\my_projects\pilo", "/root/code/pilo", "./relative"] {
            assert_eq!(
                resolved_cwd(project).as_deref(),
                Some(project),
                "project={project}"
            );
        }
    }

    #[test]
    fn windows_shell_args_preserve_profiles_and_initialize_utf8() {
        for shell in [
            "pwsh",
            "pwsh.exe",
            r"C:\Program Files\PowerShell\7\pwsh.exe",
            r"C:\Users\dev\AppData\Local\Microsoft\WindowsApps\pwsh.exe",
            "powershell",
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
        ] {
            let args = windows_shell_args(shell);
            assert_eq!(
                args,
                &[
                    "-NoLogo",
                    "-NoExit",
                    "-Command",
                    WINDOWS_POWERSHELL_UTF8_INIT
                ],
                "shell={shell}"
            );
            assert!(
                !args.contains(&"-NoProfile"),
                "PowerShell terminal must load user profile for shell={shell}"
            );
        }

        for shell in ["cmd", "cmd.exe", r"C:\Windows\system32\cmd.exe"] {
            let args = windows_shell_args(shell);
            assert_eq!(args, &["/K", "chcp 65001>NUL"], "shell={shell}");
            assert!(
                !args.contains(&"/D"),
                "cmd.exe fallback must not disable AutoRun for shell={shell}"
            );
        }

        assert!(windows_shell_args(r"C:\Program Files\Git\bin\bash.exe").is_empty());
    }
}
