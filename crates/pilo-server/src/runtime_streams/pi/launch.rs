use std::process::Stdio;

use pilo_protocol::BuiltinExtension;
use tokio::process::Command;

use super::PiStartParams;
use crate::ServerState;
use crate::environment::{default_workspace_path, process_command};

pub(super) struct PiLaunch {
    pub(super) command: Command,
    pub(super) uses_ssh_workspace: bool,
}

pub(super) fn build_launch_command(
    state: &ServerState,
    params: &PiStartParams,
    pi_executable: &str,
    path: &str,
) -> Result<PiLaunch, String> {
    let mut args = vec!["--mode".to_owned(), "rpc".to_owned()];
    if params.no_session {
        args.push("--no-session".to_owned());
    } else if let Some(path) = params.session_path.as_ref() {
        args.extend(["--session".to_owned(), path.clone()]);
    }
    let ssh_workspace = params.builtin_extensions.iter().find_map(|extension| {
        if let BuiltinExtension::SshWorkspace { config } = extension {
            Some(config)
        } else {
            None
        }
    });
    let host_resources = ssh_workspace.is_some_and(|config| config.local_pi_resources)
        && !params.disable_resources
        && !params.disable_extension_discovery
        && !params
            .builtin_extensions
            .contains(&BuiltinExtension::ModelCatalog);
    let ssh_only = ssh_workspace.is_some() && !host_resources;
    if params.disable_resources {
        args.push("--no-tools".to_owned());
    }
    if params.disable_builtin_tools || ssh_workspace.is_some() {
        args.push("--no-builtin-tools".to_owned());
    }
    if params.disable_resources || params.disable_extension_discovery || ssh_only {
        args.push("--no-extensions".to_owned());
    }
    if params.disable_resources || params.disable_context_files || ssh_workspace.is_some() {
        args.push("--no-context-files".to_owned());
    }
    if params.disable_resources || ssh_only {
        args.extend([
            "--no-skills".to_owned(),
            "--no-prompt-templates".to_owned(),
            "--no-themes".to_owned(),
        ]);
    }
    if params.disable_resources || ssh_workspace.is_some() {
        // The Pi cwd is a Host-side session anchor, not the SSH project.
        args.push("--no-approve".to_owned());
    }
    if ssh_workspace.is_none() {
        append_inline_extensions(&mut args, &params.extensions)?;
    }
    let mut ssh_workspace_config = None;
    let mut builtin_names = std::collections::HashSet::new();
    for extension in &params.builtin_extensions {
        let filename = crate::extensions::filename(extension);
        if !builtin_names.insert(filename) {
            return Err("duplicate Pi builtin extension".to_owned());
        }
        if let BuiltinExtension::SshWorkspace { config } = extension {
            if !config.remote_cwd.starts_with('/')
                || config.remote_cwd.contains('\0')
                || config.ssh_args.is_empty()
                || config.ssh_args.iter().any(|arg| arg.contains('\0'))
                || config.ssh_environment.iter().any(|(key, value)| {
                    key.is_empty() || key.contains(['=', '\0']) || value.contains('\0')
                })
            {
                return Err("invalid SSH workspace configuration".to_owned());
            }
            ssh_workspace_config =
                Some(serde_json::to_string(config).map_err(|error| error.to_string())?);
        }
        args.extend([
            "--extension".to_owned(),
            extension_path_argument(&state.extensions_dir.join(filename)),
        ]);
    }
    if host_resources {
        args.extend(["--extension".to_owned(), "builtin:mcp".to_owned()]);
        append_inline_extensions(&mut args, &params.extensions)?;
    }
    if let Some(provider) = params.provider.as_ref() {
        args.extend(["--provider".to_owned(), provider.clone()]);
    }
    if let Some(model) = params.model.as_ref() {
        args.extend(["--model".to_owned(), model.clone()]);
    }
    if let Some(thinking) = params.thinking.as_ref() {
        args.extend(["--thinking".to_owned(), thinking.clone()]);
    }
    if let Some(system_prompt) = params.system_prompt.as_ref() {
        args.extend([
            "--system-prompt".to_owned(),
            system_prompt_argument(pi_executable, system_prompt),
        ]);
    }
    // An empty, Server-owned cwd excludes every workspace's .pi configuration
    // while preserving Pi's user settings, credentials and provider extensions.
    let cwd = if params.user_scope {
        if !params.no_session {
            return Err("user model probes require an isolated no-session process".to_owned());
        }
        let cwd = crate::extensions::runtime_directory()
            .map_err(|error| format!("model catalog directory unavailable: {error}"))?
            .join("model-catalog");
        std::fs::create_dir_all(&cwd)
            .map_err(|error| format!("failed to create model catalog directory: {error}"))?;
        cwd
    } else {
        std::path::PathBuf::from(&params.project)
    };
    let mut command = process_command(pi_executable, &args, path);
    command.env_remove("PILO_STALL_QUEUE_BARRIER");
    if params
        .builtin_extensions
        .contains(&BuiltinExtension::StreamGuard)
    {
        command.env("PILO_STALL_QUEUE_BARRIER", "1");
    }
    command
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Never inherit another launcher/session's workspace configuration.
    command.env_remove("PILO_SSH_WORKSPACE_CONFIG");
    command.env_remove("PILO_SSH_LOCAL_WORKSPACE");
    if let Some(config) = ssh_workspace_config {
        command.env("PILO_SSH_WORKSPACE_CONFIG", config);
        if host_resources {
            let path = default_workspace_path("local", cfg!(debug_assertions))?;
            command.env("PILO_SSH_LOCAL_WORKSPACE", path);
        }
    }
    #[cfg(unix)]
    command.process_group(0);
    Ok(PiLaunch {
        command,
        uses_ssh_workspace: ssh_workspace.is_some(),
    })
}

/// Write an inline extension source to a content-addressed temp file so it can
/// be loaded with an explicit `--extension` flag. Pi runs in this environment,
/// so the file must live on the local (possibly remote-managed) filesystem.
fn materialize_extension(source: &str) -> Result<std::path::PathBuf, String> {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    std::hash::Hash::hash(source, &mut hasher);
    let dir = std::env::temp_dir().join("pilo-extensions");
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("failed to create extension dir: {error}"))?;
    prune_stale_extensions(&dir);
    let path = dir.join(format!("{:016x}.js", std::hash::Hasher::finish(&hasher)));
    if !path.exists() {
        std::fs::write(&path, source)
            .map_err(|error| format!("failed to write extension file: {error}"))?;
    }
    Ok(path)
}

/// Extensions are content-addressed, so distinct SSH configurations accumulate
/// distinct files. Drop entries far older than any realistic Pi session.
fn prune_stale_extensions(dir: &std::path::Path) {
    const MAX_AGE: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 60 * 60);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let Ok(modified) = entry.metadata().and_then(|metadata| metadata.modified()) else {
            continue;
        };
        if now.duration_since(modified).is_ok_and(|age| age > MAX_AGE) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn append_inline_extensions(args: &mut Vec<String>, sources: &[String]) -> Result<(), String> {
    for source in sources.iter().filter(|source| !source.trim().is_empty()) {
        let path = materialize_extension(source)?;
        args.extend(["--extension".to_owned(), extension_path_argument(&path)]);
    }
    Ok(())
}

fn extension_path_argument(path: &std::path::Path) -> String {
    let value = path.to_string_lossy();
    if cfg!(windows) {
        normalize_windows_extension_path(&value)
    } else {
        value.into_owned()
    }
}

fn normalize_windows_extension_path(value: &str) -> String {
    // Bun's module loader cannot resolve the verbatim paths returned by canonicalize.
    if let Some(value) = value.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{value}");
    }
    value.strip_prefix(r"\\?\").unwrap_or(value).to_owned()
}

/// Windows batch launchers (`pi.cmd`, `pi.bat`) reach the CLI through
/// `cmd.exe`, whose argument parsing rejects a newline outright. Native
/// launchers such as `pi` or `pi.exe` pass the value straight through, so a
/// multi-line system prompt keeps its paragraphs and lists there.
fn is_batch_launcher(executable: &str) -> bool {
    std::path::Path::new(executable)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        })
}

fn system_prompt_argument(executable: &str, prompt: &str) -> String {
    if cfg!(windows) && is_batch_launcher(executable) {
        prompt.replace(['\r', '\n'], " ")
    } else {
        prompt.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::{extension_path_argument, normalize_windows_extension_path};
    use std::path::Path;

    #[test]
    fn windows_extension_paths_use_loader_compatible_syntax() {
        for (input, expected) in [
            (
                r"\\?\C:\Users\Lenovo\AppData\Local\Pilo\server\extensions\model-catalog.js",
                r"C:\Users\Lenovo\AppData\Local\Pilo\server\extensions\model-catalog.js",
            ),
            (
                r"\\?\C:\Users\测试 用户\Pilo\extensions\next-prompt.js",
                r"C:\Users\测试 用户\Pilo\extensions\next-prompt.js",
            ),
            (
                r"\\?\UNC\server\shared folder\extensions\model-catalog.js",
                r"\\server\shared folder\extensions\model-catalog.js",
            ),
            (
                r"C:\Temp\pilo-extensions\inline.js",
                r"C:\Temp\pilo-extensions\inline.js",
            ),
            (
                r"\\server\share\extension.js",
                r"\\server\share\extension.js",
            ),
        ] {
            assert_eq!(normalize_windows_extension_path(input), expected);
        }
    }

    #[test]
    fn only_batch_launchers_are_treated_as_cmd_wrapped() {
        use super::is_batch_launcher;

        for launcher in [r"C:\tools\pi.cmd", "pi.cmd", "pi.CMD", r"C:\Pilo\pi.bat"] {
            assert!(
                is_batch_launcher(launcher),
                "{launcher} should be a batch launcher"
            );
        }
        for launcher in [
            "pi",
            "pi.exe",
            r"C:\tools\pi.exe",
            r"C:\dir.cmd\pi",
            "/usr/bin/pi",
        ] {
            assert!(
                !is_batch_launcher(launcher),
                "{launcher} should not be a batch launcher"
            );
        }
    }

    #[test]
    fn multiline_system_prompts_only_collapse_for_batch_launchers() {
        use super::system_prompt_argument;

        let prompt = "Line one\r\nLine two\nLine three";
        let batch = system_prompt_argument("pi.cmd", prompt);
        let native = system_prompt_argument("pi.exe", prompt);
        if cfg!(windows) {
            assert_eq!(batch, "Line one  Line two Line three");
        } else {
            assert_eq!(batch, prompt);
        }
        assert_eq!(native, prompt);
    }

    #[test]
    fn extension_path_arguments_only_normalize_on_windows() {
        let verbatim = r"\\?\C:\Pilo\extensions\model-catalog.js";
        assert_eq!(
            extension_path_argument(Path::new(verbatim)),
            if cfg!(windows) {
                r"C:\Pilo\extensions\model-catalog.js"
            } else {
                verbatim
            }
        );
        let ordinary = if cfg!(windows) {
            r"C:\Users\测试 用户\extensions\inline.js"
        } else {
            "/home/测试 用户/.cache/pilo/server/extensions/model-catalog.js"
        };
        assert_eq!(extension_path_argument(Path::new(ordinary)), ordinary);
    }
}
