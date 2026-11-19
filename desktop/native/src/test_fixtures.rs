use std::{
    fs::{self, DirBuilder, OpenOptions},
    io::{ErrorKind, Write},
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

use nsh_core::prelude::*;
use pilo_lib::{
    domain::{
        ConnectionNamingModel, Project, ProjectMetadata, ProjectModelCache, SessionIndexEntry,
    },
    runtime::{host_paths::HostPaths, storage},
};

pub(crate) fn register(registry: &mut Registry) {
    registry.module::<ImageFixture>();
    registry.class::<BootstrapFixture>();
    registry.class::<SessionFilesFixture>();
    registry.class::<ChatFixture>();
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

    /// Seeds a saved project catalog without starting Pi.
    pub fn seed_model_cache(&self, project_id: String) -> Result<(), String> {
        let paths = HostPaths::new(self.0.clone(), self.0.clone())?;
        let db = storage::open(&paths)?;
        let model = serde_json::json!({
            "id": "workspace-model",
            "name": "Workspace Model",
            "provider": "workspace",
            "reasoning": true,
            "scopeOrder": 0,
            "scopeThinkingLevel": "low",
        });
        storage::upsert_project_model_cache(
            &db,
            &ProjectModelCache {
                project_id,
                models: vec![model.clone()],
                commands: Some(vec![serde_json::json!({
                    "name": "fixture-command",
                    "source": "extension",
                    "sourceInfo": {
                        "path": "fixture-command.ts",
                        "source": "local",
                        "scope": "project",
                        "origin": "top-level",
                    },
                })]),
                default_model: Some(model),
                default_thinking_level: Some("medium".into()),
                refreshed_at_ms: 123,
            },
        )
    }

    /// Seeds a model scope from before the Host stored default markers.
    pub fn seed_legacy_model_scope(&self, project_id: String) -> Result<(), String> {
        let paths = HostPaths::new(self.0.clone(), self.0.clone())?;
        let models = serde_json::json!([{
            "provider": "fixture",
            "modelId": "saved-model",
            "thinkingLevel": "high",
        }]);
        storage::open(&paths)?
            .execute(
                "INSERT INTO project_model_scopes (project_id, models_json, updated_at_ms)
                 VALUES (?1, ?2, 123)",
                [project_id, models.to_string()],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    /// Seeds two local model policies in reverse catalog order.
    pub fn seed_cache_keep_alive_settings(&self) -> Result<(), String> {
        let paths = HostPaths::new(self.0.clone(), self.0.clone())?;
        storage::open(&paths)?
            .execute(
                "INSERT INTO model_cache_keep_alive_settings
                 (connection_id, provider, model_id, enabled, cache_ttl_seconds, idle_keep_alive_seconds, updated_at_ms)
                 VALUES ('local', 'fixture', 'second', 0, 600, 3600, 124),
                        ('local', 'fixture', 'first', 1, 300, 1800, 123)",
                [],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    /// Seeds enabled next-prompt settings for the local connection.
    pub fn seed_next_prompt_settings(&self) -> Result<(), String> {
        let paths = HostPaths::new(self.0.clone(), self.0.clone())?;
        storage::open(&paths)?
            .execute(
                "INSERT INTO connection_next_prompt_settings
                 (connection_id, enabled, provider, model_id, updated_at_ms)
                 VALUES ('local', 1, 'fixture', 'prediction', 123)",
                [],
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

/// An isolated project and a single synthetic Pi session file.
#[class]
struct SessionFilesFixture {
    storage: BootstrapFixture,
    session: PathBuf,
}

#[class]
impl SessionFilesFixture {
    /// Creates a fixture project plus a uniquely named session file.
    pub fn new(jsonl: String) -> Result<Self, String> {
        let storage = BootstrapFixture::new()?;
        let paths = HostPaths::new(storage.0.clone(), storage.0.clone())?;
        let db = storage::open(&paths)?;
        let cwd = storage.data_dir();
        storage::upsert_project(
            &db,
            &Project {
                id: "session-files".into(),
                name: "Session files fixture".into(),
                path: cwd.clone(),
                connection: storage::ensure_local_connection(&db)?,
                metadata: ProjectMetadata {
                    cwd: cwd.clone(),
                    git_branch: None,
                    pi_version: "test".into(),
                    refreshed_at_ms: 1,
                },
                created_at_ms: 1,
                last_opened_at_ms: 1,
            },
        )?;
        fs::write(storage.0.join("fixture.png"), ImageFixture::bytes())
            .map_err(|error| error.to_string())?;

        let sessions = std::env::var_os("PI_CODING_AGENT_DIR")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".pi/agent")))
            .ok_or("Pi agent directory is unavailable")?
            .join("sessions");
        fs::create_dir_all(&sessions).map_err(|error| error.to_string())?;
        let project_sessions = sessions.join(format!(
            "--{}--",
            cwd.trim_start_matches('/').replace(['/', '\\', ':'], "-")
        ));
        fs::create_dir(&project_sessions).map_err(|error| error.to_string())?;
        let fixture = Self {
            storage,
            session: project_sessions.join("fixture.jsonl"),
        };
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&fixture.session)
            .map_err(|error| error.to_string())?;
        let header = serde_json::json!({
            "type": "session",
            "version": 3,
            "id": "session-files-fixture",
            "cwd": cwd,
            "timestamp": "2025-01-02T03:04:05.000Z",
        });
        writeln!(file, "{header}").map_err(|error| error.to_string())?;
        file.write_all(jsonl.as_bytes())
            .map_err(|error| error.to_string())?;
        Ok(fixture)
    }

    /// Returns the isolated runtime data directory.
    pub fn data_dir(&self) -> String {
        self.storage.data_dir()
    }

    /// Returns the path of the synthetic Pi session.
    pub fn session_path(&self) -> String {
        self.session.to_string_lossy().into_owned()
    }
}

impl Drop for SessionFilesFixture {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.session);
        if let Some(dir) = self.session.parent() {
            let _ = fs::remove_dir(dir);
        }
    }
}

/// An isolated local project with a fixture Pi executable by default.
#[class]
struct ChatFixture(BootstrapFixture);

#[class]
impl ChatFixture {
    /// Seeds a test project, optionally using the installed Pi for a real smoke test.
    pub fn new(real_pi: bool) -> Result<Self, String> {
        use std::os::unix::fs::PermissionsExt;

        let data = BootstrapFixture::new()?;
        let paths = HostPaths::new(data.0.clone(), data.0.clone())?;
        let db = storage::open(&paths)?;
        let mut connection = storage::ensure_local_connection(&db)?;
        if !real_pi {
            let pi = data.0.join("fixture-pi");
            fs::write(&pi, include_str!("fixture-pi.py")).map_err(|error| error.to_string())?;
            fs::set_permissions(&pi, fs::Permissions::from_mode(0o700))
                .map_err(|error| error.to_string())?;
            connection.pi_executable = Some(pi.to_string_lossy().into_owned());
            storage::upsert_connection(&db, &connection)?;
        }
        let cwd = data.data_dir();
        storage::upsert_project(
            &db,
            &Project {
                id: "chat-fixture".into(),
                name: "Chat fixture".into(),
                path: cwd.clone(),
                connection,
                metadata: ProjectMetadata {
                    cwd,
                    git_branch: None,
                    pi_version: "test".into(),
                    refreshed_at_ms: 1,
                },
                created_at_ms: 1,
                last_opened_at_ms: 1,
            },
        )?;
        Ok(Self(data))
    }

    /// Returns the isolated runtime data directory.
    pub fn data_dir(&self) -> String {
        self.0.data_dir()
    }

    /// Writes a transcript in the isolated project directory.
    pub fn seed_transcript(&self, entries: String) -> Result<String, String> {
        let Self(BootstrapFixture(dir)) = self;
        let path = dir.join("transcript.jsonl");
        let header = serde_json::json!({
            "type": "session",
            "version": 3,
            "id": "nsh-transcript-fixture",
            "cwd": dir,
            "timestamp": "2026-01-01T00:00:00.000Z",
        });
        fs::write(&path, format!("{header}\n{entries}")).map_err(|error| error.to_string())?;
        Ok(path.to_string_lossy().into_owned())
    }

    /// Selects the synthetic Pi naming model for this fixture connection.
    pub fn configure_naming_model(&self) -> Result<(), String> {
        let Self(BootstrapFixture(dir)) = self;
        let paths = HostPaths::new(dir.clone(), dir.clone())?;
        let db = storage::open(&paths)?;
        let connection = storage::ensure_local_connection(&db)?;
        storage::upsert_connection_naming_model(
            &db,
            &ConnectionNamingModel {
                connection_id: connection.id,
                provider: "fixture".into(),
                model_id: "naming".into(),
            },
        )
    }

    /// Checks whether the local Pi child reported by the fixture is still alive.
    pub fn pi_running(&self) -> Result<bool, String> {
        let Self(BootstrapFixture(dir)) = self;
        let pid =
            fs::read_to_string(dir.join("fixture-pi.pid")).map_err(|error| error.to_string())?;
        let pid = pid.parse::<u32>().map_err(|error| error.to_string())?;
        if pid == 0 {
            return Err("invalid fixture Pi pid".into());
        }
        std::process::Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .map_err(|error| error.to_string())
    }
}
