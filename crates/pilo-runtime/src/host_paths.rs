#[cfg(test)]
use std::sync::Arc;
use std::{fmt, fs, path::PathBuf};

const DB_FILE_NAME: &str = "pilo.sqlite3";

#[derive(Clone, Debug)]
pub struct HostPaths {
    app_data_dir: DataDirectory,
    resource_dir: PathBuf,
}

#[derive(Clone)]
enum DataDirectory {
    Fixed(PathBuf),
    #[cfg(test)]
    Resolved(Arc<dyn Fn() -> Result<PathBuf, String> + Send + Sync>),
}

impl fmt::Debug for DataDirectory {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Fixed(path) => path.fmt(formatter),
            #[cfg(test)]
            Self::Resolved(_) => formatter.write_str("<host-resolved>"),
        }
    }
}

impl HostPaths {
    #[cfg(test)]
    pub fn for_test(app_data_dir: PathBuf) -> Self {
        Self {
            app_data_dir: DataDirectory::Fixed(app_data_dir),
            resource_dir: PathBuf::new(),
        }
    }

    /// A host whose data lives in `app_data_dir`, created if missing.
    pub fn new(app_data_dir: PathBuf, resource_dir: PathBuf) -> Result<Self, String> {
        let paths = Self {
            app_data_dir: DataDirectory::Fixed(app_data_dir),
            resource_dir,
        };
        paths.ensure_app_data_dir()?;
        Ok(paths)
    }

    #[cfg(test)]
    pub(crate) fn with_data_dir_resolver(
        resource_dir: PathBuf,
        resolver: impl Fn() -> Result<PathBuf, String> + Send + Sync + 'static,
    ) -> Self {
        Self {
            app_data_dir: DataDirectory::Resolved(Arc::new(resolver)),
            resource_dir,
        }
    }

    fn ensure_app_data_dir(&self) -> Result<PathBuf, String> {
        let app_data_dir = match &self.app_data_dir {
            DataDirectory::Fixed(path) => path.clone(),
            #[cfg(test)]
            DataDirectory::Resolved(resolve) => resolve()?,
        };
        fs::create_dir_all(&app_data_dir).map_err(|error| {
            format!(
                "failed to create Pilo app data directory '{}': {error}",
                app_data_dir.display()
            )
        })?;
        Ok(app_data_dir)
    }

    pub fn resource_dir(&self) -> &std::path::Path {
        &self.resource_dir
    }

    pub fn database_path(&self) -> Result<PathBuf, String> {
        Ok(self.ensure_app_data_dir()?.join(DB_FILE_NAME))
    }

    pub fn session_anchor_path(&self, project_id: &str) -> Result<PathBuf, String> {
        Ok(self
            .ensure_app_data_dir()?
            .join("pi-workspaces")
            .join(format!("{:016x}", fnv1a_64(project_id.as_bytes()))))
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
        assert_eq!(paths.database_path().unwrap(), data.join("pilo.sqlite3"));
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

    #[test]
    fn deferred_data_resolution_retries_and_storage_recreates_deleted_directory() {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };
        let root = std::env::temp_dir().join(format!("pilo-deferred-paths-{}", std::process::id()));
        let data = root.join("data");
        let ready = Arc::new(AtomicBool::new(false));
        let ready_for_resolver = ready.clone();
        let resolved_data = data.clone();
        let paths = HostPaths::with_data_dir_resolver(root.join("resources"), move || {
            if ready_for_resolver.load(Ordering::Relaxed) {
                Ok(resolved_data.clone())
            } else {
                Err("app data directory is unavailable".to_owned())
            }
        });
        assert!(!data.exists());
        assert_eq!(
            paths.database_path().unwrap_err(),
            "app data directory is unavailable"
        );
        ready.store(true, Ordering::Relaxed);
        let db = crate::storage::open_with_paths(&paths).unwrap();
        assert!(data.is_dir());
        drop(db);
        std::fs::remove_dir_all(&data).unwrap();
        let db = crate::storage::open_with_paths(&paths).unwrap();
        assert!(crate::storage::list_connections(&db).is_ok());
        drop(db);
        std::fs::remove_dir_all(&data).unwrap();
        std::fs::write(&data, b"not a directory").unwrap();
        assert!(
            paths
                .database_path()
                .unwrap_err()
                .contains("failed to create Pilo app data directory")
        );
        std::fs::remove_file(&data).unwrap();
        assert!(paths.session_anchor_path("project").is_ok());
        assert!(data.is_dir());
        std::fs::remove_dir_all(root).unwrap();
    }
}
