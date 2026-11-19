use std::{fs, path::PathBuf};

const DB_FILE_NAME: &str = "pilo.sqlite3";

#[derive(Clone, Debug)]
pub struct HostPaths {
    app_data_dir: PathBuf,
    resource_dir: PathBuf,
}

impl HostPaths {
    #[cfg(test)]
    pub fn for_test(app_data_dir: PathBuf) -> Self {
        Self {
            app_data_dir,
            resource_dir: PathBuf::new(),
        }
    }

    /// A host whose data lives in `app_data_dir`, created if missing.
    pub fn new(app_data_dir: PathBuf, resource_dir: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&app_data_dir).map_err(|error| {
            format!(
                "failed to create Pilo app data directory '{}': {error}",
                app_data_dir.display()
            )
        })?;
        Ok(Self {
            app_data_dir,
            resource_dir,
        })
    }

    pub fn resource_dir(&self) -> &std::path::Path {
        &self.resource_dir
    }

    pub fn database_path(&self) -> PathBuf {
        self.app_data_dir.join(DB_FILE_NAME)
    }

    pub fn session_anchor_path(&self, project_id: &str) -> PathBuf {
        self.app_data_dir
            .join("pi-workspaces")
            .join(format!("{:016x}", fnv1a_64(project_id.as_bytes())))
    }
}

pub fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::{HostPaths, fnv1a_64};

    #[test]
    fn host_paths_create_data_and_preserve_resource_directory() {
        let root = std::env::temp_dir().join(format!("pilo-host-paths-{}", std::process::id()));
        let data = root.join("data");
        let resources = root.join("resources");
        let paths = HostPaths::new(data.clone(), resources.clone()).unwrap();
        assert!(data.is_dir());
        assert_eq!(paths.database_path(), data.join("pilo.sqlite3"));
        assert_eq!(paths.resource_dir(), resources);
        assert!(!resources.exists());
        assert!(HostPaths::new(std::path::PathBuf::new(), resources.clone()).is_ok());
        let file = root.join("file");
        std::fs::write(&file, b"").unwrap();
        assert!(HostPaths::new(file, resources).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_anchor_hash_is_stable() {
        assert_eq!(fnv1a_64(b""), 0xcbf29ce484222325);
        assert_eq!(fnv1a_64(b"a"), 0xaf63dc4c8601ec8c);
    }
}
