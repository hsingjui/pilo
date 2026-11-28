#![cfg(unix)]

use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use super::{ElevateError, Installation, Installer, command_name};

struct Fixture {
    _root: tempfile::TempDir,
    root: PathBuf,
    calls: Arc<Mutex<Vec<String>>>,
}

fn stand_in(path: &Path, version: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        path,
        format!("#!/bin/sh\necho '{{\"cli\":\"{version}\",\"appId\":\"app.hsingjui.pilo\"}}'\n"),
    )
    .unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        Self {
            _root: dir,
            root,
            calls: Arc::default(),
        }
    }

    fn app(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }

    fn bundled(&self, app: &str) -> PathBuf {
        self.app(app)
            .join("bin")
            .join(command_name("app.hsingjui.pilo"))
    }

    /// An installer for the release app at `app`; `cancel` makes authorization fail as canceled.
    fn installer(&self, app: &str, cancel: bool, appimage: bool) -> Installer {
        let calls = self.calls.clone();
        let bundled = self.bundled(app);
        Installer {
            app_id: "app.hsingjui.pilo".into(),
            command: command_name("app.hsingjui.pilo"),
            bundled: bundled.is_file().then_some(bundled),
            installation: Some(Installation {
                source: if appimage { "appimage" } else { "installed" }.into(),
                path: self.app(app),
            }),
            data_base: self.root.join("data"),
            path_dirs: vec![self.root.join("first"), self.root.join("system")],
            system_dir: Some(self.root.join("system")),
            user_dir: self.root.join("home/.local/bin"),
            copy_dir: appimage.then(|| self.root.join("home/.local/share/pilo/bin")),
            elevate: Box::new(move |script| {
                calls.lock().unwrap().push(script.to_owned());
                if cancel {
                    Err(ElevateError::Canceled)
                } else {
                    Err(ElevateError::Failed("not in tests".into()))
                }
            }),
        }
    }

    fn system_link(&self) -> PathBuf {
        self.root.join("system/pilo")
    }
}

#[test]
fn install_is_idempotent_and_uninstall_removes_only_the_link() {
    let fixture = Fixture::new();
    stand_in(&fixture.bundled("Pilo.app"), "0.5.2");
    let installer = fixture.installer("Pilo.app", false, false);
    assert_eq!(installer.status().state, "not_installed");

    let first = installer.install(false).unwrap();
    assert_eq!(first.outcome, Some("installed"));
    assert_eq!(first.state, "ready");
    assert_eq!(first.installed_version.as_deref(), Some("0.5.2"));
    assert_eq!(
        std::fs::read_link(fixture.system_link()).unwrap(),
        fixture.bundled("Pilo.app")
    );
    let second = installer.install(false).unwrap();
    assert_eq!(second.state, "ready");

    let removed = installer.uninstall().unwrap();
    assert_eq!(removed.outcome, Some("uninstalled"));
    assert_eq!(removed.state, "not_installed");
    assert!(std::fs::symlink_metadata(fixture.system_link()).is_err());
    assert!(fixture.bundled("Pilo.app").is_file());
    assert_eq!(installer.uninstall().unwrap().state, "not_installed");
}

#[test]
fn third_party_files_are_reported_and_never_overwritten() {
    let fixture = Fixture::new();
    stand_in(&fixture.bundled("Pilo.app"), "0.5.2");
    stand_in(&fixture.system_link(), "brew");
    let installer = fixture.installer("Pilo.app", false, false);
    let status = installer.status();
    assert_eq!(status.state, "conflict");
    assert_eq!(status.conflict_path, Some(fixture.system_link()));

    let result = installer.install(false).unwrap();
    assert_eq!(result.outcome, Some("conflict"));
    assert!(installer.load_record().is_none());
    assert!(
        std::fs::read_to_string(fixture.system_link())
            .unwrap()
            .contains("brew")
    );
}

#[test]
fn canceled_authorization_falls_back_to_the_user_bin() {
    let fixture = Fixture::new();
    stand_in(&fixture.bundled("Pilo.app"), "0.5.2");
    let system = fixture.root.join("system");
    std::fs::create_dir_all(&system).unwrap();
    std::fs::set_permissions(&system, std::fs::Permissions::from_mode(0o555)).unwrap();
    let installer = fixture.installer("Pilo.app", true, false);

    let status = installer.install(false).unwrap();
    std::fs::set_permissions(&system, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(status.outcome, Some("fallback"));
    assert_eq!(status.state, "not_in_path");
    let link = fixture.root.join("home/.local/bin/pilo");
    assert_eq!(status.entry_path, Some(link.clone()));
    assert_eq!(
        std::fs::read_link(link).unwrap(),
        fixture.bundled("Pilo.app")
    );
    assert_eq!(fixture.calls.lock().unwrap().len(), 1);
}

#[test]
fn canceled_authorization_keeps_the_link_on_uninstall() {
    let fixture = Fixture::new();
    stand_in(&fixture.bundled("Pilo.app"), "0.5.2");
    let installer = fixture.installer("Pilo.app", true, false);
    installer.install(false).unwrap();
    let system = fixture.root.join("system");
    std::fs::set_permissions(&system, std::fs::Permissions::from_mode(0o555)).unwrap();

    let status = installer.uninstall().unwrap();
    std::fs::set_permissions(&system, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(status.outcome, Some("canceled"));
    assert_eq!(status.state, "ready");
    assert!(installer.load_record().is_some());
    assert!(fixture.calls.lock().unwrap()[0].contains("rm -f"));
}

#[test]
fn external_rewrites_are_conflicts_and_survive_uninstall() {
    let fixture = Fixture::new();
    stand_in(&fixture.bundled("Pilo.app"), "0.5.2");
    let installer = fixture.installer("Pilo.app", false, false);
    installer.install(false).unwrap();
    let other = fixture.root.join("elsewhere/pilo");
    stand_in(&other, "9.9.9");
    std::fs::remove_file(fixture.system_link()).unwrap();
    std::os::unix::fs::symlink(&other, fixture.system_link()).unwrap();

    assert_eq!(installer.status().state, "conflict");
    assert_eq!(installer.install(true).unwrap().outcome, Some("conflict"));
    installer.uninstall().unwrap();
    assert_eq!(std::fs::read_link(fixture.system_link()).unwrap(), other);
}

#[test]
fn moved_apps_are_stale_and_repair_relinks() {
    let fixture = Fixture::new();
    stand_in(&fixture.bundled("Old.app"), "0.5.2");
    fixture
        .installer("Old.app", false, false)
        .install(false)
        .unwrap();
    std::fs::rename(fixture.app("Old.app"), fixture.app("New.app")).unwrap();

    let installer = fixture.installer("New.app", false, false);
    let status = installer.status();
    assert_eq!((status.state, status.reason), ("stale", Some("moved")));
    let repaired = installer.install(true).unwrap();
    assert_eq!(repaired.state, "ready");
    assert_eq!(
        std::fs::read_link(fixture.system_link()).unwrap(),
        fixture.bundled("New.app")
    );
}

#[test]
fn another_app_copy_is_reported_as_other_app() {
    let fixture = Fixture::new();
    stand_in(&fixture.bundled("A.app"), "0.5.2");
    stand_in(&fixture.bundled("B.app"), "0.5.2");
    fixture
        .installer("A.app", false, false)
        .install(false)
        .unwrap();
    let status = fixture.installer("B.app", false, false).status();
    assert_eq!((status.state, status.reason), ("stale", Some("other_app")));
}

#[test]
fn earlier_path_entries_shadow_the_command() {
    let fixture = Fixture::new();
    stand_in(&fixture.bundled("Pilo.app"), "0.5.2");
    stand_in(&fixture.root.join("first/pilo"), "brew");
    let status = fixture
        .installer("Pilo.app", false, false)
        .install(false)
        .unwrap();
    assert_eq!(status.state, "ready");
    assert_eq!(status.shadowed_by, Some(fixture.root.join("first/pilo")));
}

#[test]
fn missing_bundled_cli_is_unavailable() {
    let fixture = Fixture::new();
    let installer = fixture.installer("Pilo.app", false, false);
    assert_eq!(installer.status().state, "unavailable");
    assert!(installer.install(false).is_err());
}

#[test]
fn appimage_links_a_persistent_copy_synced_at_launch() {
    let fixture = Fixture::new();
    stand_in(&fixture.bundled("mount"), "0.5.2");
    let installer = fixture.installer("mount", false, true);
    let installed = installer.install(false).unwrap();
    let copy = fixture.root.join("home/.local/share/pilo/bin/pilo");
    assert_eq!(installed.state, "ready");
    assert_eq!(std::fs::read_link(fixture.system_link()).unwrap(), copy);
    assert!(!installer.sync_on_launch().unwrap());

    stand_in(&fixture.bundled("mount"), "0.6.0");
    assert_eq!(installer.status().reason, Some("outdated"));
    assert!(installer.sync_on_launch().unwrap());
    assert_eq!(installer.status().state, "ready");
    assert_eq!(
        installer.status().installed_version.as_deref(),
        Some("0.6.0")
    );

    installer.uninstall().unwrap();
    assert!(!copy.exists());
    assert!(!installer.sync_on_launch().unwrap());
    assert!(!copy.exists());
}

#[test]
fn dev_and_release_commands_differ() {
    assert_eq!(command_name("app.hsingjui.pilo"), "pilo");
    assert_eq!(command_name("app.hsingjui.pilo.dev"), "pilo-dev");
}
