mod appearance;
pub(crate) use appearance::*;
mod cache_keep_alive;
pub(crate) use cache_keep_alive::*;
mod connections;
mod desktop;
pub(crate) use desktop::*;
mod next_prompt;
mod projects;
mod prompt_enhancement;
pub(crate) use next_prompt::*;
pub(crate) use prompt_enhancement::*;
mod remote;
mod schema;
mod session_reads;
mod sessions;

pub use connections::*;
pub use projects::*;
pub(crate) use remote::*;
pub(crate) use schema::open_with_paths;
pub use schema::{now_ms, open};
pub(crate) use session_reads::*;
pub use sessions::*;

#[cfg(test)]
use crate::domain::{
    Connection, ConnectionNamingModel, Project, ProjectMetadata, ProjectModelCache,
};
#[cfg(test)]
use rusqlite::{Connection as SqliteConnection, params};
#[cfg(test)]
use schema::{initialize_schema, table_exists};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_project_does_not_overwrite_connection_configuration() {
        let db = SqliteConnection::open_in_memory().expect("open in-memory SQLite");
        db.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        initialize_schema(&db).expect("initialize schema");

        let current_connection = Connection {
            id: "wsl:Debian".to_owned(),
            name: "Current Debian".to_owned(),
            pi_executable: Some("/opt/pi/bin/pi".to_owned()),
            pi_runtime: crate::domain::PiRuntime::default(),
            kind: crate::domain::ConnectionKind::Wsl {
                distro: "Debian".to_owned(),
            },
            shown_in_home: false,
        };
        upsert_connection(&db, &current_connection).expect("persist current connection");

        let project = Project {
            id: "project:wsl:Debian:/code/demo".to_owned(),
            name: "demo".to_owned(),
            path: "/code/demo".to_owned(),
            connection: Connection {
                id: current_connection.id.clone(),
                name: "Stale Debian".to_owned(),
                pi_executable: None,
                pi_runtime: crate::domain::PiRuntime::default(),
                kind: crate::domain::ConnectionKind::Wsl {
                    distro: "Debian-old".to_owned(),
                },
                shown_in_home: false,
            },
            metadata: ProjectMetadata {
                cwd: "/code/demo".to_owned(),
                git_branch: Some("main".to_owned()),
                pi_version: "1.0.0".to_owned(),
                refreshed_at_ms: 1,
            },
            created_at_ms: 1,
            last_opened_at_ms: 2,
        };
        upsert_project(&db, &project).expect("persist project");

        assert_eq!(
            get_connection(&db, &current_connection.id).expect("read connection"),
            Some(current_connection)
        );
    }

    #[test]
    fn connection_shown_in_home_defaults_local_visible_and_survives_upsert() {
        let db = SqliteConnection::open_in_memory().expect("open in-memory SQLite");
        db.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        initialize_schema(&db).expect("initialize schema");

        let local = ensure_local_connection(&db).expect("ensure local connection");
        assert!(local.shown_in_home, "local should be shown by default");

        assert!(set_connection_shown_in_home(&db, "local", false).expect("hide local"));
        assert!(!get_connection(&db, "local").unwrap().unwrap().shown_in_home);

        // upsert（保存连接设置/SSH 编辑）不得覆盖用户选择的可见性。
        upsert_connection(&db, &local).expect("upsert local connection");
        assert!(!get_connection(&db, "local").unwrap().unwrap().shown_in_home);
    }

    #[test]
    fn connection_naming_model_round_trips_and_clears() {
        let db = SqliteConnection::open_in_memory().expect("open in-memory SQLite");
        initialize_schema(&db).expect("initialize schema");

        let model = ConnectionNamingModel {
            connection_id: "wsl:Debian".to_owned(),
            provider: "openai".to_owned(),
            model_id: "gpt-5.6-mini".to_owned(),
        };
        upsert_connection_naming_model(&db, &model).expect("persist naming model");

        assert_eq!(
            get_connection_naming_model(&db, &model.connection_id).expect("read naming model"),
            Some(model.clone())
        );
        assert_eq!(
            list_connection_naming_models(&db).expect("list naming models"),
            vec![model.clone()]
        );

        clear_connection_naming_model(&db, &model.connection_id).expect("clear naming model");
        assert!(
            get_connection_naming_model(&db, &model.connection_id)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn prompt_enhancement_defaults_to_disabled_and_keeps_the_model() {
        let db = SqliteConnection::open_in_memory().expect("open in-memory SQLite");
        db.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        initialize_schema(&db).expect("initialize schema");
        db.execute_batch(
            "INSERT INTO connections(id,name,kind_json,updated_at_ms) VALUES('local','Local','{\"type\":\"local\"}',1);",
        )
        .expect("seed connection");

        assert_eq!(
            get_prompt_enhancement_settings(&db, "local").expect("read defaults"),
            crate::domain::PromptEnhancementSettings {
                connection_id: "local".to_owned(),
                enabled: false,
                model: None,
                updated_at_ms: 0,
            }
        );

        let model = crate::domain::PromptEnhancementModel {
            provider: "openai".to_owned(),
            id: "gpt-5.6-mini".to_owned(),
        };
        let enabled = set_prompt_enhancement_settings(&db, "local", true, Some(model.clone()))
            .expect("enable enhancement");
        assert!(enabled.enabled);
        assert_eq!(enabled.model, Some(model.clone()));

        // Disabling keeps the chosen model; the revision still advances.
        let disabled = set_prompt_enhancement_settings(&db, "local", false, Some(model.clone()))
            .expect("disable enhancement");
        assert!(!disabled.enabled);
        assert_eq!(disabled.model, Some(model));
        assert!(disabled.updated_at_ms > enabled.updated_at_ms);

        assert!(set_prompt_enhancement_settings(&db, "missing", true, None).is_err());
        assert!(get_prompt_enhancement_settings(&db, "missing").is_err());
    }

    const LEGACY_SCHEMA: &str = "CREATE TABLE connections (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           kind_json TEXT NOT NULL,
           updated_at_ms INTEGER NOT NULL
         );
         CREATE TABLE workspaces (
           id TEXT PRIMARY KEY,
           connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
           name TEXT NOT NULL,
           path TEXT NOT NULL,
           metadata_json TEXT NOT NULL,
           created_at_ms INTEGER NOT NULL,
           last_opened_at_ms INTEGER NOT NULL
         );
         CREATE INDEX idx_workspaces_recent ON workspaces(last_opened_at_ms DESC);
         CREATE TABLE sessions (
           session_path TEXT PRIMARY KEY,
           connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
           pi_session_id TEXT NOT NULL,
           name TEXT,
           cwd TEXT NOT NULL,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           message_count INTEGER NOT NULL,
           last_message_at TEXT,
           first_user_message_preview TEXT,
           file_size INTEGER NOT NULL,
           file_mtime_ns INTEGER NOT NULL,
           last_offset INTEGER NOT NULL,
           indexed_at_ms INTEGER NOT NULL
         );
         CREATE INDEX idx_sessions_workspace_updated ON sessions(workspace_id, updated_at DESC);
         CREATE UNIQUE INDEX idx_sessions_workspace_pi_id ON sessions(workspace_id, pi_session_id);
         CREATE TABLE session_ui_state (
           session_path TEXT PRIMARY KEY,
           pinned INTEGER NOT NULL DEFAULT 0,
           title_override TEXT,
           updated_at_ms INTEGER NOT NULL
         );";

    #[test]
    fn upgrades_existing_project_model_cache_with_default_state_columns() {
        let db = SqliteConnection::open_in_memory().expect("open in-memory SQLite");
        db.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE connections (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               kind_json TEXT NOT NULL,
               updated_at_ms INTEGER NOT NULL
             );
             CREATE TABLE projects (
               id TEXT PRIMARY KEY,
               connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
               name TEXT NOT NULL,
               path TEXT NOT NULL,
               metadata_json TEXT NOT NULL,
               created_at_ms INTEGER NOT NULL,
               last_opened_at_ms INTEGER NOT NULL
             );
             CREATE TABLE project_model_cache (
               project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
               models_json TEXT NOT NULL,
               refreshed_at_ms INTEGER NOT NULL
             );",
        )
        .expect("create previous model-cache schema");

        initialize_schema(&db).expect("upgrade model-cache schema");

        let has_column = |name: &str| {
            db.query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('project_model_cache') WHERE name=?1)",
                params![name],
                |row| row.get::<_, i64>(0),
            )
            .unwrap()
                != 0
        };
        assert!(has_column("default_model_json"));
        assert!(has_column("default_thinking_level"));
        assert!(has_column("commands_json"));
    }

    #[test]
    fn persists_project_model_cache_and_cascades_on_project_delete() {
        let db = SqliteConnection::open_in_memory().expect("open in-memory SQLite");
        db.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        initialize_schema(&db).expect("initialize schema");
        db.execute_batch(
            "INSERT INTO connections(id,name,kind_json,updated_at_ms) VALUES('local','Local','{\"type\":\"local\"}',1);
             INSERT INTO projects(id,connection_id,name,path,metadata_json,created_at_ms,last_opened_at_ms)
               VALUES('project:local:/code/demo','local','demo','/code/demo','{\"cwd\":\"/code/demo\",\"gitBranch\":\"main\",\"piVersion\":\"1.0.0\",\"refreshedAtMs\":5}',10,20);",
        )
        .expect("seed project");

        let cache = ProjectModelCache {
            project_id: "project:local:/code/demo".to_owned(),
            commands: None,
            models: vec![serde_json::json!({
                "provider": "pivia",
                "id": "gpt-5.6-sol",
                "name": "gpt-5.6-sol",
                "reasoning": true
            })],
            default_model: Some(serde_json::json!({
                "provider": "pivia",
                "id": "gpt-5.6-sol",
                "name": "gpt-5.6-sol",
                "reasoning": true
            })),
            default_thinking_level: Some("high".to_owned()),
            refreshed_at_ms: 42,
        };
        upsert_project_model_cache(&db, &cache).expect("persist model cache");

        let snapshots = list_project_model_cache(&db).expect("read model cache");
        assert_eq!(snapshots, vec![cache.clone()]);

        let mut with_commands = cache.clone();
        with_commands.commands = Some(vec![serde_json::json!({
            "name": "example",
            "source": "extension"
        })]);
        with_commands.refreshed_at_ms += 1;
        upsert_project_model_cache(&db, &with_commands).expect("persist command catalog");
        assert_eq!(
            list_project_model_cache(&db).unwrap(),
            vec![with_commands.clone()]
        );

        let mut legacy_client = with_commands.clone();
        legacy_client.commands = None;
        legacy_client.refreshed_at_ms += 1;
        upsert_project_model_cache(&db, &legacy_client)
            .expect("preserve commands for older client");
        with_commands.refreshed_at_ms = legacy_client.refreshed_at_ms;
        assert_eq!(
            list_project_model_cache(&db).unwrap(),
            vec![with_commands.clone()]
        );

        let mut empty_commands = with_commands.clone();
        empty_commands.commands = Some(Vec::new());
        empty_commands.refreshed_at_ms += 1;
        upsert_project_model_cache(&db, &empty_commands).expect("persist empty command catalog");
        upsert_project_model_cache(&db, &with_commands).expect("ignore older command catalog");
        assert_eq!(list_project_model_cache(&db).unwrap(), vec![empty_commands]);

        remove_project(&db, "project:local:/code/demo").expect("remove project");
        assert!(list_project_model_cache(&db).unwrap().is_empty());
    }

    #[test]
    fn project_order_round_trips_and_rejects_incomplete_orders() {
        let mut db = SqliteConnection::open_in_memory().expect("open in-memory SQLite");
        db.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        initialize_schema(&db).expect("initialize schema");
        db.execute_batch(
            "INSERT INTO connections(id,name,kind_json,updated_at_ms) VALUES('local','Local','{\"type\":\"local\"}',1);
             INSERT INTO projects(id,connection_id,name,path,metadata_json,created_at_ms,last_opened_at_ms,sort_order) VALUES
               ('project:local:/code/a','local','a','/code/a','{\"cwd\":\"/code/a\",\"gitBranch\":null,\"piVersion\":\"1\",\"refreshedAtMs\":1}',1,3,0),
               ('project:local:/code/b','local','b','/code/b','{\"cwd\":\"/code/b\",\"gitBranch\":null,\"piVersion\":\"1\",\"refreshedAtMs\":1}',1,2,1),
               ('project:local:/code/c','local','c','/code/c','{\"cwd\":\"/code/c\",\"gitBranch\":null,\"piVersion\":\"1\",\"refreshedAtMs\":1}',1,1,2);",
        )
        .expect("seed projects");

        let order = vec![
            "project:local:/code/c".to_owned(),
            "project:local:/code/a".to_owned(),
            "project:local:/code/b".to_owned(),
        ];
        reorder_projects(&mut db, "local", &order).expect("reorder projects");
        assert_eq!(
            list_projects(&db)
                .unwrap()
                .into_iter()
                .map(|project| project.id)
                .collect::<Vec<_>>(),
            order
        );
        assert!(reorder_projects(&mut db, "local", &["project:local:/code/a".to_owned()]).is_err());
    }

    #[test]
    fn removing_connection_cascades_project_records() {
        let db = SqliteConnection::open_in_memory().expect("open in-memory SQLite");
        db.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        initialize_schema(&db).expect("initialize schema");
        db.execute_batch(
            "INSERT INTO connections(id,name,kind_json,updated_at_ms)
               VALUES('wsl:Debian','Debian','{\"type\":\"wsl\",\"distro\":\"Debian\"}',1);
             INSERT INTO projects(id,connection_id,name,path,metadata_json,created_at_ms,last_opened_at_ms)
               VALUES('project:wsl:Debian:/code/demo','wsl:Debian','demo','/code/demo','{\"cwd\":\"/code/demo\",\"gitBranch\":null,\"piVersion\":\"1.0.0\",\"refreshedAtMs\":5}',10,20);",
        )
        .expect("seed connection and project");

        assert_eq!(connection_project_count(&db, "wsl:Debian").unwrap(), 1);
        assert!(remove_connection(&db, "wsl:Debian").expect("remove connection"));
        assert_eq!(connection_project_count(&db, "wsl:Debian").unwrap(), 0);
        assert!(list_projects(&db).expect("list projects").is_empty());
    }

    #[test]
    fn migrates_legacy_workspaces_schema_in_place() {
        let db = SqliteConnection::open_in_memory().expect("open in-memory SQLite");
        db.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        db.execute_batch(LEGACY_SCHEMA)
            .expect("create legacy schema");
        db.execute_batch(
            "INSERT INTO connections(id,name,kind_json,updated_at_ms) VALUES('local','Local','{\"type\":\"local\"}',1);
             INSERT INTO workspaces(id,connection_id,name,path,metadata_json,created_at_ms,last_opened_at_ms)
               VALUES('workspace:local:/code/demo','local','demo','/code/demo','{\"cwd\":\"/code/demo\",\"gitBranch\":\"main\",\"piVersion\":\"1.0.0\",\"refreshedAtMs\":5}',10,20);
             INSERT INTO sessions(session_path,connection_id,workspace_id,pi_session_id,name,cwd,created_at,updated_at,message_count,last_message_at,first_user_message_preview,file_size,file_mtime_ns,last_offset,indexed_at_ms)
               VALUES('/sessions/a.jsonl','local','workspace:local:/code/demo','s1',NULL,'/code/demo','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',0,NULL,'hi',10,20,30,40);",
        )
        .expect("seed legacy rows");

        initialize_schema(&db).expect("migrate legacy schema");

        assert!(!table_exists(&db, "workspaces").unwrap());
        let projects = list_projects(&db).unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].id, "project:local:/code/demo");
        assert_eq!(projects[0].path, "/code/demo");

        let sessions = list_sessions(&db, "project:local:/code/demo").unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].project_id, "project:local:/code/demo");

        let foreign_key_issues: i64 = db
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .expect("foreign key check runs");
        assert_eq!(foreign_key_issues, 0);
    }
}
