use std::{collections::BTreeMap, fs, process::Stdio, time::Duration};

use base64::{Engine as _, engine::general_purpose};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::process::Command;

use crate::domain::{Connection, ConnectionKind, SshAuthMethod, SshTarget};

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

pub(in crate::runtime) fn validate_agent_identity(target: &SshTarget) -> Result<(), String> {
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

pub(crate) async fn ssh_tunnel_command(
    connection: &Connection,
    local_port: u16,
    remote_port: u16,
) -> Result<Command, String> {
    let ConnectionKind::Ssh { target } = &connection.kind else {
        return Err("SSH tunnel requires an SSH connection".to_owned());
    };
    let args = ssh_tunnel_args(target, local_port, remote_port)?;
    check_agent_key_config(target, &args).await?;
    let mut command = Command::new("ssh");
    command.args(args);
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

pub(crate) fn ssh_tunnel_args(
    target: &SshTarget,
    local_port: u16,
    remote_port: u16,
) -> Result<Vec<String>, String> {
    if local_port == 0 || remote_port == 0 {
        return Err("SSH tunnel ports must be between 1 and 65535".to_owned());
    }

    let mut args = ssh_base_args(target)?;
    let destination = args
        .pop()
        .ok_or_else(|| "SSH target is missing".to_owned())?;
    args.splice(1..1, ["-N".to_owned()]);
    args.extend([
        "-o".to_owned(),
        "ExitOnForwardFailure=yes".to_owned(),
        "-L".to_owned(),
        format!("127.0.0.1:{local_port}:127.0.0.1:{remote_port}"),
        destination,
    ]);
    Ok(args)
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

pub fn print_askpass_password_from_environment() -> bool {
    let Some(connection_id) = std::env::var_os(ASKPASS_CONNECTION_ENV) else {
        return false;
    };
    let connection_id = connection_id.to_string_lossy();
    match super::credentials::get_ssh_password(&connection_id) {
        Ok(password) => {
            print!("{password}");
            true
        }
        Err(_) => true,
    }
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
}
