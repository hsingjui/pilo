use std::{
    fs::{self, DirBuilder},
    io::ErrorKind,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

use nsh_core::prelude::*;
use pilo_lib::{
    domain::SessionIndexEntry,
    runtime::{host_paths::HostPaths, storage},
};

pub(crate) fn register(registry: &mut Registry) {
    registry.module::<ImageFixture>();
    registry.class::<BootstrapFixture>();
}

/// Native image sources for the desktop transport tests.
#[module]
struct ImageFixture;

#[module]
impl ImageFixture {
    /// The fixture PNG as native bytes.
    pub fn bytes() -> Vec<u8> {
        include_bytes!("../../../src-tauri/icons/32x32.png").to_vec()
    }

    /// The fixture PNG as an absolute local path.
    pub fn path() -> String {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../src-tauri/icons/32x32.png")
            .to_string_lossy()
            .into_owned()
    }
}

/// An isolated data directory owned by the native bootstrap fixture.
#[class]
struct BootstrapFixture(PathBuf);

#[class]
impl BootstrapFixture {
    /// Creates fixture storage without touching the installed application's data.
    pub fn new() -> Result<Self, String> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir();
        let mut builder = DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        loop {
            let sequence = NEXT.fetch_add(1, Ordering::Relaxed);
            let path = root.join(format!("pilo-nsh-test-{}-{sequence}", std::process::id()));
            match builder.create(&path) {
                Ok(()) => return Ok(Self(path)),
                Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.to_string()),
            }
        }
    }

    /// Returns the fixture directory.
    pub fn data_dir(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }

    /// Seeds appearance settings from before the Host stored theme tokens.
    pub fn seed_legacy_theme_settings(&self, css: String) -> Result<(), String> {
        let paths = HostPaths::new(self.0.clone(), self.0.clone())?;
        let settings = serde_json::json!({
            "revision": 7,
            "themeFamily": "custom",
            "themeCustomCss": css,
            "themeCustomName": "Legacy",
            "savedCustomThemes": [{ "name": "Legacy", "css": css }],
        });
        storage::open(&paths)?
            .execute(
                "INSERT INTO theme_settings (id, settings_json) VALUES (1, ?1)",
                [settings.to_string()],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    /// Saves an indexed session for a fixture project without starting Pi.
    pub fn seed_indexed_session(&self, project_id: String, cwd: String) -> Result<(), String> {
        let paths = HostPaths::new(self.0.clone(), self.0.clone())?;
        let db = storage::open(&paths)?;
        storage::upsert_session(
            &db,
            &SessionIndexEntry {
                connection_id: "local".into(),
                project_id,
                pi_session_id: "saved-session".into(),
                session_path: self
                    .0
                    .join("saved-session.jsonl")
                    .to_string_lossy()
                    .into_owned(),
                name: Some("Saved session".into()),
                cwd,
                created_at: "2026-01-01T00:00:00Z".into(),
                updated_at: "2026-01-01T00:00:01Z".into(),
                message_count: 1,
                last_message_at: Some("2026-01-01T00:00:01Z".into()),
                first_user_message_preview: None,
                file_size: 100,
                file_mtime_ns: 1_767_225_601_000_000_001,
                last_offset: 100,
                indexed_at_ms: 1_767_225_601_000,
                pinned: false,
                title_override: None,
            },
        )
    }

    /// Records a fixture session with two completed turns and no acknowledgment.
    pub fn seed_session_read_state(&self, project_id: String) -> Result<String, String> {
        let paths = HostPaths::new(self.0.clone(), self.0.clone())?;
        let mut db = storage::open(&paths)?;
        let session_path = self
            .0
            .join("read-state-session.jsonl")
            .to_string_lossy()
            .into_owned();
        let transaction = db.transaction().map_err(|error| error.to_string())?;
        transaction
            .execute(
                "UPDATE session_read_revision SET revision = 2 WHERE id = 1",
                [],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO session_read_state (project_id, session_path, completed_revision) VALUES (?1, ?2, 2)",
                [&project_id, &session_path],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(session_path)
    }
}

impl Drop for BootstrapFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
