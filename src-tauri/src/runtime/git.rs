use pilo_protocol::CommandOutput;
use serde::Serialize;
use serde_json::json;

use crate::domain::{ConnectionKind, Workspace};

use super::server_client::ServerManager;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,
    pub original_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: Option<String>,
    pub files: Vec<GitFileStatus>,
}

pub async fn status(servers: &ServerManager, workspace: &Workspace) -> Result<GitStatus, String> {
    let branch = branch(servers, workspace).await;
    let output = run_checked(
        servers,
        workspace,
        "git",
        &[
            "--no-optional-locks",
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
        ],
    )
    .await?;
    Ok(GitStatus {
        branch,
        files: parse_porcelain_v1_z(&output),
    })
}

pub async fn diff(
    servers: &ServerManager,
    workspace: &Workspace,
    path: Option<&str>,
    staged: bool,
) -> Result<String, String> {
    let mut args = vec![
        "--no-pager".to_owned(),
        "diff".to_owned(),
        "--no-ext-diff".to_owned(),
        "--no-color".to_owned(),
        "--unified=3".to_owned(),
    ];
    if staged {
        args.push("--cached".to_owned());
    }
    if let Some(path) = path {
        args.extend(["--".to_owned(), path.to_owned()]);
    }

    let output = run_checked_owned(servers, workspace, "git", &args).await?;
    if !output.is_empty() || staged || path.is_none() {
        return Ok(String::from_utf8_lossy(&output).into_owned());
    }

    let Some(path) = path else {
        return Ok(String::new());
    };
    if !is_untracked(servers, workspace, path).await? {
        return Ok(String::new());
    }

    let args = vec![
        "--no-pager".to_owned(),
        "diff".to_owned(),
        "--no-index".to_owned(),
        "--no-color".to_owned(),
        "--unified=3".to_owned(),
        "--".to_owned(),
        if cfg!(windows) && matches!(workspace.connection.kind, ConnectionKind::Local) {
            "NUL".to_owned()
        } else {
            "/dev/null".to_owned()
        },
        path.to_owned(),
    ];
    let output = run(servers, workspace, "git", &args, &[]).await?;
    if output.code == Some(0) || output.code == Some(1) {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }
    Err(command_error("git", &output))
}

pub async fn run_checked_owned(
    servers: &ServerManager,
    workspace: &Workspace,
    program: &str,
    args: &[String],
) -> Result<Vec<u8>, String> {
    let output = run(servers, workspace, program, args, &[]).await?;
    if output.code == Some(0) {
        Ok(output.stdout)
    } else {
        Err(command_error(program, &output))
    }
}

pub async fn run_checked(
    servers: &ServerManager,
    workspace: &Workspace,
    program: &str,
    args: &[&str],
) -> Result<Vec<u8>, String> {
    let args = args
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    run_checked_owned(servers, workspace, program, &args).await
}

pub async fn run(
    servers: &ServerManager,
    workspace: &Workspace,
    program: &str,
    args: &[String],
    input: &[u8],
) -> Result<CommandOutput, String> {
    servers
        .request_typed(
            &workspace.connection,
            "command.run",
            json!({
                "workspace": workspace.path,
                "program": program,
                "args": args,
                "input": input,
            }),
        )
        .await
}

async fn branch(servers: &ServerManager, workspace: &Workspace) -> Option<String> {
    if let Ok(output) = run_checked(
        servers,
        workspace,
        "git",
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
    )
    .await
    {
        let value = String::from_utf8_lossy(&output).trim().to_owned();
        if !value.is_empty() {
            return Some(value);
        }
    }
    let output = run_checked(servers, workspace, "git", &["rev-parse", "--short", "HEAD"])
        .await
        .ok()?;
    let value = String::from_utf8_lossy(&output).trim().to_owned();
    (!value.is_empty()).then(|| format!("detached@{value}"))
}

async fn is_untracked(
    servers: &ServerManager,
    workspace: &Workspace,
    path: &str,
) -> Result<bool, String> {
    let output = run_checked_owned(
        servers,
        workspace,
        "git",
        &[
            "ls-files".to_owned(),
            "--others".to_owned(),
            "--exclude-standard".to_owned(),
            "--".to_owned(),
            path.to_owned(),
        ],
    )
    .await?;
    Ok(!output.is_empty())
}

fn command_error(program: &str, output: &CommandOutput) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.trim().is_empty() {
        format!("'{program}' exited with {:?}", output.code)
    } else {
        format!("'{program}' failed: {}", stderr.trim())
    }
}

fn parse_porcelain_v1_z(bytes: &[u8]) -> Vec<GitFileStatus> {
    let mut records = bytes.split(|byte| *byte == 0).peekable();
    let mut files = Vec::new();
    while let Some(record) = records.next() {
        if record.len() < 4 {
            continue;
        }
        let index = record[0] as char;
        let worktree = record[1] as char;
        let path = String::from_utf8_lossy(&record[3..]).into_owned();
        let renamed = matches!(index, 'R' | 'C') || matches!(worktree, 'R' | 'C');
        let original_path = if renamed {
            records
                .next()
                .filter(|value| !value.is_empty())
                .map(|value| String::from_utf8_lossy(value).into_owned())
        } else {
            None
        };
        let untracked = index == '?' && worktree == '?';
        files.push(GitFileStatus {
            path,
            original_path,
            index_status: index.to_string(),
            worktree_status: worktree.to_string(),
            staged: !matches!(index, ' ' | '?'),
            unstaged: worktree != ' ' || untracked,
            untracked,
        });
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_status_and_rename_records() {
        let bytes = b" M src/App.tsx\0A  new.txt\0?? notes.txt\0R  new-name.ts\0old-name.ts\0";
        let files = parse_porcelain_v1_z(bytes);
        assert_eq!(files.len(), 4);
        assert_eq!(files[0].path, "src/App.tsx");
        assert!(files[0].unstaged);
        assert!(!files[0].staged);
        assert_eq!(files[1].index_status, "A");
        assert!(files[1].staged);
        assert!(files[2].untracked);
        assert_eq!(files[3].path, "new-name.ts");
        assert_eq!(files[3].original_path.as_deref(), Some("old-name.ts"));
    }
}
