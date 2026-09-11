use crate::domain::SshTarget;

const SSH_CONNECT_TIMEOUT_SECONDS: u64 = 10;

pub(crate) fn ssh_base_args(target: &SshTarget) -> Result<Vec<String>, String> {
    let mut args = vec![
        "-T".to_owned(),
        "-o".to_owned(),
        "BatchMode=yes".to_owned(),
        "-o".to_owned(),
        format!("ConnectTimeout={SSH_CONNECT_TIMEOUT_SECONDS}"),
        "-o".to_owned(),
        "RemoteCommand=none".to_owned(),
    ];
    append_target_args(&mut args, target)?;
    Ok(args)
}

pub(crate) fn ssh_tunnel_args(
    target: &SshTarget,
    local_port: u16,
    remote_port: u16,
) -> Result<Vec<String>, String> {
    if local_port == 0 || remote_port == 0 {
        return Err("SSH tunnel ports must be between 1 and 65535".to_owned());
    }

    let mut args = vec![
        "-T".to_owned(),
        "-N".to_owned(),
        "-o".to_owned(),
        "BatchMode=yes".to_owned(),
        "-o".to_owned(),
        format!("ConnectTimeout={SSH_CONNECT_TIMEOUT_SECONDS}"),
        "-o".to_owned(),
        "RemoteCommand=none".to_owned(),
        "-o".to_owned(),
        "ExitOnForwardFailure=yes".to_owned(),
        "-L".to_owned(),
        format!("127.0.0.1:{local_port}:127.0.0.1:{remote_port}"),
    ];
    append_target_args(&mut args, target)?;
    Ok(args)
}

fn append_target_args(args: &mut Vec<String>, target: &SshTarget) -> Result<(), String> {
    match target {
        SshTarget::ConfigHost { host } => {
            validate_destination(host, "SSH config host")?;
            args.push(host.clone());
        }
        SshTarget::Direct {
            hostname,
            port,
            user,
            identity_file,
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
            if let Some(identity_file) = identity_file {
                if identity_file.trim().is_empty() || identity_file.contains('\0') {
                    return Err("SSH identity file cannot be empty".to_owned());
                }
                args.extend(["-i".to_owned(), identity_file.clone()]);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_host_base_args_preserve_openssh_config() {
        let args = ssh_base_args(&SshTarget::ConfigHost {
            host: "devbox".to_owned(),
        })
        .unwrap();

        assert_eq!(
            args,
            [
                "-T",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                "-o",
                "RemoteCommand=none",
                "devbox"
            ]
        );
    }

    #[test]
    fn direct_target_keeps_explicit_connection_options() {
        let args = ssh_base_args(&SshTarget::Direct {
            hostname: "192.0.2.10".to_owned(),
            port: Some(2222),
            user: Some("deploy".to_owned()),
            identity_file: Some("~/.ssh/deploy key".to_owned()),
        })
        .unwrap();

        assert!(args.windows(2).any(|pair| pair == ["-p", "2222"]));
        assert!(args.windows(2).any(|pair| pair == ["-l", "deploy"]));
        assert!(
            args.windows(2)
                .any(|pair| pair == ["-i", "~/.ssh/deploy key"])
        );
        assert_eq!(args.last().map(String::as_str), Some("192.0.2.10"));
    }

    #[test]
    fn rejects_option_like_or_whitespace_destinations() {
        for host in ["", "-Fother-config", "dev box", "dev\nbox"] {
            assert!(
                ssh_base_args(&SshTarget::ConfigHost {
                    host: host.to_owned(),
                })
                .is_err()
            );
        }
    }

    #[test]
    fn tunnel_args_request_forward_only_connection() {
        let args = ssh_tunnel_args(
            &SshTarget::ConfigHost {
                host: "devbox".to_owned(),
            },
            42123,
            3000,
        )
        .unwrap();

        assert!(args.iter().any(|arg| arg == "-N"));
        assert!(args.iter().any(|arg| arg == "ExitOnForwardFailure=yes"));
        assert!(
            args.iter()
                .any(|arg| arg == "127.0.0.1:42123:127.0.0.1:3000")
        );
    }

    #[test]
    fn shell_quote_handles_single_quotes() {
        assert_eq!(shell_quote("/srv/it's pilo"), "'/srv/it'\"'\"'s pilo'");
    }
}
