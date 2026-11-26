use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    process::Stdio,
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::process::Command;

use pilo_domain::{Connection, ConnectionKind, SshAuthMethod, SshTarget};

const SSH_CONNECT_TIMEOUT_SECONDS: u64 = 5;
pub(super) const ASKPASS_CONNECTION_ENV: &str = "PILO_SSH_ASKPASS_CONNECTION_ID";
pub(super) const ASKPASS_ATTEMPT_ENV: &str = "PILO_SSH_DIAGNOSTIC_ATTEMPT_ID";
pub(super) const ASKPASS_DIAGNOSTIC_PREFIX: &str = "[pilo-ssh-askpass]";

pub(super) fn stderr_without_askpass_diagnostics(stderr: &[u8]) -> String {
    // Diagnostic records must not change frontend error classification.
    String::from_utf8_lossy(stderr)
        .split_inclusive('\n')
        .filter(|line| !line.starts_with(ASKPASS_DIAGNOSTIC_PREFIX))
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshAgentIdentity {
    public_key: String,
    fingerprint: String,
    comment: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigHost {
    pub host: String,
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
}

fn user_ssh_dir() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)?;
    Some(home.join(".ssh"))
}

const MAX_SSH_CONFIG_BYTES: u64 = 256 * 1024;
const PRIVATE_KEY_HEADER_SNIFF_BYTES: u64 = 64;

fn wildcard_matches(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let mut star_pi: Option<usize> = None;
    let mut star_ti = 0usize;
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star_pi = Some(pi);
            pi += 1;
            star_ti = ti;
        } else if let Some(sp) = star_pi {
            pi = sp + 1;
            star_ti += 1;
            ti = star_ti;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

fn read_bounded_utf8(path: &std::path::Path, limit: u64) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut content = String::new();
    file.take(limit).read_to_string(&mut content).ok()?;
    Some(content)
}

fn looks_like_private_key_file(path: &std::path::Path) -> bool {
    let Ok(file) = fs::File::open(path) else {
        return false;
    };
    let mut head = Vec::with_capacity(PRIVATE_KEY_HEADER_SNIFF_BYTES as usize);
    if file
        .take(PRIVATE_KEY_HEADER_SNIFF_BYTES)
        .read_to_end(&mut head)
        .is_err()
    {
        return false;
    }
    head.windows(b"PRIVATE KEY".len())
        .any(|window| window == b"PRIVATE KEY")
}

fn parse_ssh_config_file(
    path: &std::path::Path,
    ssh_dir: &std::path::Path,
    depth: usize,
    visited: &mut std::collections::HashSet<std::path::PathBuf>,
    hosts: &mut Vec<SshConfigHost>,
    seen_hosts: &mut std::collections::HashSet<String>,
) {
    if depth > 4 {
        return;
    }
    let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if !visited.insert(canonical) {
        return;
    }
    let Some(content) = read_bounded_utf8(path, MAX_SSH_CONFIG_BYTES) else {
        return;
    };
    let mut current_indices: Vec<usize> = Vec::new();
    for raw_line in content.lines() {
        let line = raw_line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let Some((keyword, value)) = line
            .split_once(|c: char| c.is_whitespace() || c == '=')
            .map(|(k, v)| {
                (
                    k.trim().to_ascii_lowercase(),
                    v.trim().trim_start_matches('=').trim(),
                )
            })
        else {
            continue;
        };
        if value.is_empty() {
            continue;
        }
        match keyword.as_str() {
            "include" => {
                for pattern in value.split_whitespace() {
                    let expanded = if let Some(rest) = pattern.strip_prefix("~/") {
                        ssh_dir
                            .parent()
                            .map(|home| home.join(rest))
                            .unwrap_or_else(|| ssh_dir.join(pattern))
                    } else if std::path::Path::new(pattern).is_absolute() {
                        std::path::PathBuf::from(pattern)
                    } else {
                        ssh_dir.join(pattern)
                    };
                    if let Some(name) = expanded.file_name().and_then(|n| n.to_str())
                        && (name.contains('*') || name.contains('?'))
                        && let Some(parent) = expanded.parent()
                        && let Ok(entries) = fs::read_dir(parent)
                    {
                        let mut paths: Vec<_> = entries
                            .filter_map(Result::ok)
                            .map(|e| e.path())
                            .filter(|p| {
                                p.is_file()
                                    && p.file_name()
                                        .and_then(|file_name| file_name.to_str())
                                        .is_some_and(|file_name| wildcard_matches(name, file_name))
                            })
                            .collect();
                        paths.sort();
                        for child in paths {
                            parse_ssh_config_file(
                                &child,
                                ssh_dir,
                                depth + 1,
                                visited,
                                hosts,
                                seen_hosts,
                            );
                        }
                    } else if expanded.is_file() {
                        parse_ssh_config_file(
                            &expanded,
                            ssh_dir,
                            depth + 1,
                            visited,
                            hosts,
                            seen_hosts,
                        );
                    }
                }
            }
            "host" => {
                current_indices.clear();
                for alias in value.split_whitespace() {
                    let alias = alias.trim_matches('"');
                    if alias.is_empty()
                        || alias.contains('*')
                        || alias.contains('?')
                        || alias.starts_with('!')
                    {
                        continue;
                    }
                    if seen_hosts.insert(alias.to_owned()) {
                        let idx = hosts.len();
                        hosts.push(SshConfigHost {
                            host: alias.to_owned(),
                            hostname: None,
                            user: None,
                            port: None,
                        });
                        current_indices.push(idx);
                    }
                }
            }
            "match" => {
                current_indices.clear();
            }
            "hostname" => {
                let cleaned = value.trim_matches('"').to_owned();
                for &idx in &current_indices {
                    if hosts[idx].hostname.is_none() {
                        hosts[idx].hostname = Some(cleaned.clone());
                    }
                }
            }
            "user" => {
                let cleaned = value.trim_matches('"').to_owned();
                for &idx in &current_indices {
                    if hosts[idx].user.is_none() {
                        hosts[idx].user = Some(cleaned.clone());
                    }
                }
            }
            "port" => {
                if let Ok(port) = value.trim_matches('"').parse::<u16>() {
                    for &idx in &current_indices {
                        if hosts[idx].port.is_none() {
                            hosts[idx].port = Some(port);
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

pub(crate) fn list_config_hosts() -> Vec<SshConfigHost> {
    let Some(ssh_dir) = user_ssh_dir() else {
        return Vec::new();
    };
    let config_path = ssh_dir.join("config");
    if !config_path.is_file() {
        return Vec::new();
    }
    let mut visited = std::collections::HashSet::new();
    let mut seen_hosts = std::collections::HashSet::new();
    let mut hosts = Vec::new();
    parse_ssh_config_file(
        &config_path,
        &ssh_dir,
        0,
        &mut visited,
        &mut hosts,
        &mut seen_hosts,
    );
    hosts
}

pub(crate) fn list_local_private_keys() -> Vec<String> {
    let Some(ssh_dir) = user_ssh_dir() else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&ssh_dir) else {
        return Vec::new();
    };
    let mut keys = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name.starts_with('.')
            || name.ends_with(".pub")
            || matches!(
                name,
                "config" | "known_hosts" | "known_hosts.old" | "authorized_keys" | "environment"
            )
        {
            continue;
        }
        let has_pub = ssh_dir.join(format!("{name}.pub")).is_file();
        let looks_like_key = has_pub || looks_like_private_key_file(&path);
        if looks_like_key {
            keys.push(format!("~/.ssh/{name}"));
        }
    }
    keys.sort();
    keys
}

pub(crate) async fn list_agent_identities() -> Result<Vec<SshAgentIdentity>, String> {
    let mut command = Command::new("ssh-add");
    command.arg("-L").stdin(Stdio::null()).kill_on_drop(true);
    super::hide_console_window(&mut command);
    let output = tokio::time::timeout(Duration::from_secs(5), command.output())
        .await
        .map_err(|_| "SSH agent timed out while listing public keys".to_owned())?
        .map_err(|error| format!("failed to run ssh-add: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        if stdout.trim() == "The agent has no identities."
            || stderr.trim() == "The agent has no identities."
        {
            return Ok(Vec::new());
        }
        return Err("could not list public keys from the SSH agent".to_owned());
    }

    let mut identities = Vec::<SshAgentIdentity>::new();
    for line in stdout.lines() {
        let mut fields = line.splitn(3, ' ');
        let (Some(kind), Some(encoded)) = (fields.next(), fields.next()) else {
            continue;
        };
        let public_key = format!("{kind} {encoded}");
        let Some(blob) = public_key_blob(&public_key) else {
            continue;
        };
        if identities
            .iter()
            .any(|identity| identity.public_key == public_key)
        {
            continue;
        }
        identities.push(SshAgentIdentity {
            public_key,
            fingerprint: format!(
                "SHA256:{}",
                general_purpose::STANDARD_NO_PAD.encode(Sha256::digest(blob))
            ),
            comment: fields
                .next()
                .unwrap_or_default()
                .trim()
                .chars()
                .filter(|character| !character.is_control())
                .take(120)
                .collect(),
        });
    }
    Ok(identities)
}

pub(crate) fn validate_agent_identity(target: &SshTarget) -> Result<(), String> {
    if let SshAuthMethod::AgentKey(key) = target.auth_method() {
        if public_key_blob(key).is_none() {
            return Err("invalid SSH agent public key".to_owned());
        }
        if matches!(
            target,
            SshTarget::Direct {
                identity_file: Some(_),
                ..
            }
        ) {
            return Err("SSH agent key cannot be combined with a private key path".to_owned());
        }
    }
    Ok(())
}

fn public_key_blob(public_key: &str) -> Option<Vec<u8>> {
    if public_key.len() > 32 * 1024 {
        return None;
    }
    let (kind, encoded) = public_key.split_once(' ')?;
    if kind.is_empty()
        || !kind.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'@' | b'+')
        })
    {
        return None;
    }
    let blob = general_purpose::STANDARD.decode(encoded).ok()?;
    let kind_length = u32::try_from(kind.len()).ok()?.to_be_bytes();
    let fields = blob.strip_prefix(kind_length.as_slice())?;
    let key_data = fields.strip_prefix(kind.as_bytes())?;
    (!key_data.is_empty()).then_some(blob)
}

fn agent_identity_path(key: &str) -> Result<String, String> {
    let dir = pilo_server::runtime_directory()
        .map_err(|error| format!("failed to resolve SSH agent public key cache: {error}"))?
        .join("ssh-agent-keys");
    let path = dir.join(format!("{:x}.pub", Sha256::digest(key.as_bytes())));
    let contents = format!("{key}\n");
    if !fs::read(&path).is_ok_and(|cached| cached == contents.as_bytes()) {
        // The same key can be opened concurrently by independent SSH commands.
        let mut nonce = [0; 16];
        getrandom::fill(&mut nonce)
            .map_err(|error| format!("failed to name SSH agent public key cache file: {error}"))?;
        let temporary = dir.join(format!("{:032x}.tmp", u128::from_be_bytes(nonce)));
        let result = fs::create_dir_all(&dir)
            .and_then(|()| fs::write(&temporary, contents))
            .and_then(|()| fs::rename(&temporary, &path));
        if let Err(error) = result {
            let _ = fs::remove_file(&temporary);
            return Err(format!("failed to cache SSH agent public key: {error}"));
        }
    }
    path.into_os_string()
        .into_string()
        .map_err(|_| "SSH agent public key cache path is not valid UTF-8".to_owned())
}

pub(crate) fn ssh_base_args(target: &SshTarget) -> Result<Vec<String>, String> {
    validate_agent_identity(target)?;
    let batch_mode = !matches!(target.auth_method(), SshAuthMethod::Password);
    let mut args = vec![
        "-T".to_owned(),
        "-o".to_owned(),
        format!("BatchMode={}", if batch_mode { "yes" } else { "no" }),
        "-o".to_owned(),
        format!("ConnectTimeout={SSH_CONNECT_TIMEOUT_SECONDS}"),
        // BatchMode=yes turns ssh's "(yes/no)" host key prompt into a hard
        // "Host key verification failed", so trust a new host key on first use
        // (like interactive ssh) while still rejecting a changed key.
        "-o".to_owned(),
        "StrictHostKeyChecking=accept-new".to_owned(),
        "-o".to_owned(),
        "RemoteCommand=none".to_owned(),
    ];
    if matches!(target.auth_method(), SshAuthMethod::Password) {
        args.extend([
            "-o".to_owned(),
            "PreferredAuthentications=password,keyboard-interactive".to_owned(),
            "-o".to_owned(),
            "PubkeyAuthentication=no".to_owned(),
            "-o".to_owned(),
            "NumberOfPasswordPrompts=1".to_owned(),
        ]);
    }
    if let SshAuthMethod::AgentKey(key) = target.auth_method() {
        // OpenSSH accepts a public IdentityFile and asks the agent to sign.
        args.extend([
            "-i".to_owned(),
            agent_identity_path(key)?,
            "-o".to_owned(),
            "IdentitiesOnly=yes".to_owned(),
            "-o".to_owned(),
            "PreferredAuthentications=publickey".to_owned(),
            "-o".to_owned(),
            "PubkeyAuthentication=yes".to_owned(),
            "-o".to_owned(),
            "PKCS11Provider=none".to_owned(),
            "-o".to_owned(),
            "CertificateFile=none".to_owned(),
            "-o".to_owned(),
            "ControlPath=none".to_owned(),
        ]);
    }
    append_target_args(&mut args, target)?;
    Ok(args)
}

pub(super) async fn check_agent_key_config(
    target: &SshTarget,
    args: &[String],
) -> Result<(), String> {
    if !matches!(target.auth_method(), SshAuthMethod::AgentKey(_)) {
        return Ok(());
    }
    let selected = args
        .windows(2)
        .find(|pair| pair[0] == "-i")
        .map(|pair| pair[1].as_str())
        .ok_or_else(|| "SSH agent public key is missing from the command".to_owned())?;
    // IdentityFile and CertificateFile accumulate even with IdentitiesOnly=yes.
    // Let OpenSSH resolve Host, Include and Match without dropping route settings.
    let mut command = Command::new("ssh");
    command
        .arg("-G")
        .args(args)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    super::hide_console_window(&mut command);
    let output = tokio::time::timeout(Duration::from_secs(5), command.output())
        .await
        .map_err(|_| "timed out while checking OpenSSH configuration".to_owned())?
        .map_err(|error| format!("failed to check OpenSSH configuration: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "failed to resolve OpenSSH configuration: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let config = String::from_utf8_lossy(&output.stdout);
    let mut selected_found = false;
    for (name, value) in config.lines().filter_map(|line| line.split_once(' ')) {
        match name {
            "identityfile" if value == selected => selected_found = true,
            "identityfile" | "certificatefile" if value != "none" => {
                return Err(concat!(
                    "OpenSSH config adds another IdentityFile or CertificateFile. ",
                    "Remove it for this host, or use SSH defaults instead of a selected agent key."
                )
                .to_owned());
            }
            _ => {}
        }
    }
    if !selected_found {
        return Err("OpenSSH configuration did not retain the selected agent key".to_owned());
    }
    Ok(())
}

pub(crate) async fn ssh_command(connection: &Connection) -> Result<Command, String> {
    ssh_command_with_options(connection, &[]).await
}

pub(super) async fn ssh_command_with_options(
    connection: &Connection,
    options: &[&str],
) -> Result<Command, String> {
    let ConnectionKind::Ssh { target } = &connection.kind else {
        return Err("SSH command requires an SSH connection".to_owned());
    };
    let args = ssh_base_args(target)?;
    check_agent_key_config(target, &args).await?;
    let mut command = Command::new("ssh");
    command.args(options).args(args);
    if matches!(target.auth_method(), SshAuthMethod::Password) {
        super::credentials::get_ssh_password(&connection.id)?;
        let executable = std::env::current_exe().map_err(|error| {
            format!("failed to locate Pilo executable for SSH askpass: {error}")
        })?;
        command.env("SSH_ASKPASS", executable);
        command.env("SSH_ASKPASS_REQUIRE", "force");
        command.env(ASKPASS_CONNECTION_ENV, &connection.id);
        if std::env::var_os("DISPLAY").is_none() {
            command.env("DISPLAY", "pilo:0");
        }
        command.stdin(Stdio::null());
    }
    super::hide_console_window(&mut command);
    Ok(command)
}

pub(crate) fn ssh_child_environment(
    connection: &Connection,
) -> Result<BTreeMap<String, String>, String> {
    let ConnectionKind::Ssh { target } = &connection.kind else {
        return Err("SSH child environment requires an SSH connection".to_owned());
    };
    let mut environment = BTreeMap::new();
    if !matches!(target.auth_method(), SshAuthMethod::Password) {
        return Ok(environment);
    }
    super::credentials::get_ssh_password(&connection.id)?;
    let executable = std::env::current_exe()
        .map_err(|error| format!("failed to locate Pilo executable for SSH askpass: {error}"))?;
    environment.insert(
        "SSH_ASKPASS".to_owned(),
        executable.to_string_lossy().into_owned(),
    );
    environment.insert("SSH_ASKPASS_REQUIRE".to_owned(), "force".to_owned());
    environment.insert(ASKPASS_CONNECTION_ENV.to_owned(), connection.id.clone());
    if std::env::var_os("DISPLAY").is_none() {
        environment.insert("DISPLAY".to_owned(), "pilo:0".to_owned());
    }
    Ok(environment)
}

fn append_target_args(args: &mut Vec<String>, target: &SshTarget) -> Result<(), String> {
    match target {
        SshTarget::ConfigHost { host, .. } => {
            validate_destination(host, "SSH config host")?;
            args.push(host.clone());
        }
        SshTarget::Direct {
            hostname,
            port,
            user,
            identity_file,
            auth_method,
            proxy_jump,
        } => {
            validate_destination(hostname, "SSH hostname")?;
            if *port == Some(0) {
                return Err("SSH port must be between 1 and 65535".to_owned());
            }
            if let Some(port) = port {
                args.extend(["-p".to_owned(), port.to_string()]);
            }
            if let Some(user) = user {
                validate_option_value(user, "SSH user")?;
                args.extend(["-l".to_owned(), user.clone()]);
            }
            if matches!(auth_method, SshAuthMethod::Key) && identity_file.is_none() {
                return Err("SSH private key path is required for key authentication".to_owned());
            }
            if let Some(identity_file) = identity_file {
                if identity_file.trim().is_empty() || identity_file.contains('\0') {
                    return Err("SSH identity file cannot be empty".to_owned());
                }
                args.extend(["-i".to_owned(), identity_file.clone()]);
                if matches!(auth_method, SshAuthMethod::Key) {
                    args.extend(["-o".to_owned(), "IdentitiesOnly=yes".to_owned()]);
                }
            }
            if let Some(proxy_jump) = proxy_jump {
                validate_destination(proxy_jump, "SSH proxy jump")?;
                args.extend(["-J".to_owned(), proxy_jump.clone()]);
            }
            args.push(hostname.clone());
        }
    }
    Ok(())
}

fn validate_destination(value: &str, label: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty()
        || value.starts_with('-')
        || value
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(format!("{label} is invalid"));
    }
    Ok(())
}

fn validate_option_value(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty()
        || value
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(format!("{label} is invalid"));
    }
    Ok(())
}

pub(crate) fn wrap_posix_script(script: &str) -> String {
    format!("/bin/sh -c {}", shell_quote(script))
}

pub(crate) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

pub(super) fn print_askpass_password_from_environment() -> Option<i32> {
    let connection_id = std::env::var(ASKPASS_CONNECTION_ENV).ok()?;
    // Other nsh runners (such as the type describer) must not answer the prompt.
    if std::env::var("SSH_ASKPASS_REQUIRE").ok()?.as_str() != "force"
        || std::env::var_os("SSH_ASKPASS")? != std::env::current_exe().ok()?.into_os_string()
    {
        return None;
    }
    let Ok(password) = super::credentials::get_ssh_password(&connection_id) else {
        return Some(1);
    };
    let mut stdout = std::io::stdout().lock();
    let result = stdout
        .write_all(password.as_bytes())
        .and_then(|()| stdout.flush());
    Some(i32::from(result.is_err()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_host_base_args_preserve_openssh_config() {
        let args = ssh_base_args(&SshTarget::ConfigHost {
            host: "devbox".to_owned(),
            auth_method: SshAuthMethod::Agent,
        })
        .unwrap();
        assert_eq!(args.last().map(String::as_str), Some("devbox"));
        assert!(args.windows(2).any(|pair| pair == ["-o", "BatchMode=yes"]));
    }

    #[test]
    fn direct_target_keeps_explicit_connection_options() {
        let args = ssh_base_args(&SshTarget::Direct {
            hostname: "192.0.2.10".to_owned(),
            port: Some(2222),
            user: Some("deploy".to_owned()),
            identity_file: Some("~/.ssh/deploy key".to_owned()),
            auth_method: SshAuthMethod::Key,
            proxy_jump: Some("jump.example.com".to_owned()),
        })
        .unwrap();
        assert!(args.windows(2).any(|pair| pair == ["-p", "2222"]));
        assert!(args.windows(2).any(|pair| pair == ["-l", "deploy"]));
        assert!(
            args.windows(2)
                .any(|pair| pair == ["-i", "~/.ssh/deploy key"])
        );
        assert!(
            args.windows(2)
                .any(|pair| pair == ["-J", "jump.example.com"])
        );
        assert_eq!(args.last().map(String::as_str), Some("192.0.2.10"));
    }

    #[test]
    fn password_auth_enables_askpass_compatible_mode() {
        let args = ssh_base_args(&SshTarget::Direct {
            hostname: "example.com".to_owned(),
            port: None,
            user: None,
            identity_file: None,
            auth_method: SshAuthMethod::Password,
            proxy_jump: None,
        })
        .unwrap();
        assert!(args.windows(2).any(|pair| pair == ["-o", "BatchMode=no"]));
        assert!(args.iter().any(|arg| arg == "PubkeyAuthentication=no"));
    }

    #[test]
    fn rejects_option_like_or_whitespace_destinations() {
        for host in ["", "-Fother-config", "dev box", "dev\nbox"] {
            assert!(
                ssh_base_args(&SshTarget::ConfigHost {
                    host: host.to_owned(),
                    auth_method: SshAuthMethod::Agent,
                })
                .is_err()
            );
        }
    }

    #[test]
    fn shell_quote_handles_single_quotes() {
        assert_eq!(shell_quote("/srv/it's pilo"), "'/srv/it'\"'\"'s pilo'");
    }

    #[test]
    fn wildcard_matches_filters_ssh_include_filenames() {
        assert!(wildcard_matches("*.conf", "work.conf"));
        assert!(!wildcard_matches("*.conf", "id_ed25519"));
        assert!(!wildcard_matches("*.conf", "work.conf.bak"));
        assert!(wildcard_matches("host-?.cfg", "host-1.cfg"));
        assert!(!wildcard_matches("host-?.cfg", "host-12.cfg"));
        assert!(wildcard_matches("*", "anything"));
    }

    #[test]
    fn parse_ssh_config_include_only_reads_matching_files() {
        let dir =
            std::env::temp_dir().join(format!("pilo-ssh-include-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let main_cfg = dir.join("config");
        fs::write(&main_cfg, "Include *.conf\n").unwrap();
        fs::write(dir.join("prod.conf"), "Host prod\n  HostName 10.0.0.1\n").unwrap();
        fs::write(
            dir.join("id_ed25519"),
            "-----BEGIN OPENSSH PRIVATE KEY-----\nHost leaked\n",
        )
        .unwrap();

        let mut visited = std::collections::HashSet::new();
        let mut seen_hosts = std::collections::HashSet::new();
        let mut hosts = Vec::new();
        parse_ssh_config_file(
            &main_cfg,
            &dir,
            0,
            &mut visited,
            &mut hosts,
            &mut seen_hosts,
        );
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].host, "prod");
        assert!(looks_like_private_key_file(&dir.join("id_ed25519")));
        assert!(!looks_like_private_key_file(&dir.join("prod.conf")));

        let _ = fs::remove_dir_all(&dir);
    }
}
