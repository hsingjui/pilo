use std::{fs, path::PathBuf};

use tauri::{AppHandle, Manager};

const DB_FILE_NAME: &str = "pilo.sqlite3";

#[derive(Clone, Debug)]
pub(crate) struct HostPaths {
    app_data_dir: PathBuf,
}

impl HostPaths {
    pub(crate) fn from_app(app: &AppHandle) -> Result<Self, String> {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("failed to resolve Pilo app data directory: {error}"))?;
        fs::create_dir_all(&app_data_dir).map_err(|error| {
            format!(
                "failed to create Pilo app data directory '{}': {error}",
                app_data_dir.display()
            )
        })?;
        Ok(Self { app_data_dir })
    }

    pub(crate) fn database_path(&self) -> PathBuf {
        self.app_data_dir.join(DB_FILE_NAME)
    }

    pub(crate) fn session_anchor_path(&self, project_id: &str) -> PathBuf {
        self.app_data_dir
            .join("pi-workspaces")
            .join(format!("{:016x}", fnv1a_64(project_id.as_bytes())))
    }
}

fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::fnv1a_64;

    #[test]
    fn project_anchor_hash_is_stable() {
        assert_eq!(fnv1a_64(b""), 0xcbf29ce484222325);
        assert_eq!(fnv1a_64(b"a"), 0xaf63dc4c8601ec8c);
    }
}
