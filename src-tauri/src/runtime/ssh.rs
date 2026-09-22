use std::{collections::BTreeMap, process::Stdio};

use tokio::process::Command;

use crate::domain::{Connection, ConnectionKind, SshAuthMethod, SshTarget};

const SSH_CONNECT_TIMEOUT_SECONDS: u64 = 5;
const ASKPASS_CONNECTION_ENV: &str = "PILO_SSH_ASKPASS_CONNECTION_ID";

pub(crate) fn ssh_base_args(target: &SshTarget) -> Result<Vec<String>, String> {
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
    append_target_args(&mut args, target)?;
    Ok(args)
}

pub(crate) fn ssh_command(connection: &Connection) -> Result<Command, String> {
    let ConnectionKind::Ssh { target } = &connection.kind else {
        return Err("SSH command requires an SSH connection".to_owned());
    };
    let mut command = Command::new("ssh");
    command.args(ssh_base_args(target)?);
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

pub(crate) fn ssh_tunnel_command(
    connection: &Connection,
    local_port: u16,
    remote_port: u16,
) -> Result<Command, String> {
    let ConnectionKind::Ssh { target } = &connection.kind else {
        return Err("SSH tunnel requires an SSH connection".to_owned());
    };
    let mut command = Command::new("ssh");
    command.args(ssh_tunnel_args(target, local_port, remote_port)?);
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
