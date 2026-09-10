use std::{collections::BTreeMap, io, path::PathBuf, process::Stdio};

use serde::{Deserialize, Serialize};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSpec {
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

pub struct ManagedProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    stderr: ChildStderr,
}

impl ManagedProcess {
    pub fn spawn(spec: &ProcessSpec) -> io::Result<Self> {
        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        if let Some(cwd) = &spec.cwd {
            command.current_dir(cwd);
        }

        if !spec.env.is_empty() {
            command.envs(&spec.env);
        }

        let mut child = command.spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("spawned process is missing piped stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("spawned process is missing piped stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| io::Error::other("spawned process is missing piped stderr"))?;

        Ok(Self {
            child,
            stdin,
            stdout,
            stderr,
        })
    }

    pub fn into_parts(self) -> (Child, ChildStdin, ChildStdout, ChildStderr) {
        (self.child, self.stdin, self.stdout, self.stderr)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_spec_round_trips_launch_configuration() {
        let spec = ProcessSpec {
            program: "pi".to_owned(),
            args: vec!["--mode".to_owned(), "rpc".to_owned()],
            cwd: Some(PathBuf::from("/workspace")),
            env: BTreeMap::from([("PI_OFFLINE".to_owned(), "1".to_owned())]),
        };

        let encoded = serde_json::to_value(&spec).unwrap();
        let decoded: ProcessSpec = serde_json::from_value(encoded).unwrap();
        assert_eq!(decoded, spec);
    }
}
