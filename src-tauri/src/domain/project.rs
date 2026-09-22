use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::Connection;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectPiRuntime {
    #[default]
    Workspace,
    Local,
}

impl ProjectPiRuntime {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Workspace => "workspace",
            Self::Local => "local",
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "workspace" => Ok(Self::Workspace),
            "local" => Ok(Self::Local),
            _ => Err(format!("unknown Pi runtime '{value}'")),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub connection: Connection,
    #[serde(default)]
    pub pi_runtime: ProjectPiRuntime,
    pub metadata: ProjectMetadata,
    pub created_at_ms: u64,
    pub last_opened_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMetadata {
    pub cwd: String,
    pub git_branch: Option<String>,
    pub pi_version: String,
    pub refreshed_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectModelCache {
    pub project_id: String,
    pub models: Vec<Value>,
    pub default_model: Option<Value>,
    pub default_thinking_level: Option<String>,
    pub refreshed_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredProject {
    pub name: String,
    pub path: String,
    pub already_added: bool,
}

impl Project {
    pub fn stable_id(connection_id: &str, path: &str) -> String {
        format!("project:{connection_id}:{path}")
    }

    pub fn name_from_path(path: &str) -> String {
        let trimmed = path.trim_end_matches(['/', '\\']);
        if trimmed.is_empty() {
            return path.to_owned();
        }

        trimmed
            .rsplit(['/', '\\'])
            .find(|part| !part.is_empty())
            .unwrap_or(trimmed)
            .to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_project_name_from_posix_and_windows_paths() {
        assert_eq!(Project::name_from_path("/root/code/pilo"), "pilo");
        assert_eq!(Project::name_from_path("C:\\Code\\pilo\\"), "pilo");
        assert_eq!(Project::name_from_path("/"), "/");
    }

    #[test]
    fn stable_id_keeps_connection_and_path_identity() {
        assert_eq!(
            Project::stable_id("wsl:Debian", "/root/code/pilo"),
            "project:wsl:Debian:/root/code/pilo"
        );
    }
}
