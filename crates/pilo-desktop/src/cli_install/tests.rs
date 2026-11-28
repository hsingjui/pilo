#![cfg(unix)]

use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use super::{
    ElevateError, Installation, Installer, command_name, insert_path_entry, path_segments,
    remove_path_entry, write_new,
};

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

    /// An installer whose authorization succeeds: `meanwhile` runs while the
    /// prompt would be open, then the script runs with the system dir writable.
    fn elevating_installer(
        &self,
        app: &str,
        meanwhile: impl Fn() + Send + Sync + 'static,
    ) -> Installer {
        let mut installer = self.installer(app, false, false);
        let system = self.root.join("system");
        installer.elevate = Box::new(move |script| {
            meanwhile();
            std::fs::set_permissions(&system, std::fs::Permissions::from_mode(0o755)).unwrap();
            let output = std::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(script)
                .output()
                .unwrap();
            std::fs::set_permissions(&system, std::fs::Permissions::from_mode(0o555)).unwrap();
            let stderr = String::from_utf8_lossy(&output.stderr);
            match output.status.success() {
                true => Ok(()),
                false if stderr.contains("pilo-cli-conflict") => Err(ElevateError::Conflict),
                false => Err(ElevateError::Failed(stderr.into_owned())),
            }
        });
        installer
    }

    fn lock_system(&self, locked: bool) {
        let mode = if locked { 0o555 } else { 0o755 };
        let system = self.root.join("system");
        std::fs::create_dir_all(&system).unwrap();
        std::fs::set_permissions(system, std::fs::Permissions::from_mode(mode)).unwrap();
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

#[test]
fn authorized_install_links_through_the_elevated_script() {
    let fixture = Fixture::new();
    stand_in(&fixture.bundled("Pilo.app"), "0.5.2");
    let installer = fixture.elevating_installer("Pilo.app", || {});
    fixture.lock_system(true);
    let status = installer.install(false).unwrap();
    fixture.lock_system(false);
    assert_eq!(status.outcome, Some("installed"));
    assert_eq!(
        std::fs::read_link(fixture.system_link()).unwrap(),
        fixture.bundled("Pilo.app")
    );
}

#[test]
fn authorized_install_never_overwrites_a_file_created_meanwhile() {
    let fixture = Fixture::new();
    stand_in(&fixture.bundled("Pilo.app"), "0.5.2");
    let link = fixture.system_link();
    let installer = fixture.elevating_installer("Pilo.app", move || {
        std::fs::set_permissions(
            link.parent().unwrap(),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        std::fs::write(&link, "third party").unwrap();
    });
    fixture.lock_system(true);
    let status = installer.install(false).unwrap();
    fixture.lock_system(false);
    assert_eq!(status.outcome, Some("conflict"));
    assert_eq!(
        std::fs::read_to_string(fixture.system_link()).unwrap(),
        "third party"
    );
    assert!(installer.load_record().is_none());
}

#[test]
fn authorized_uninstall_keeps_a_link_repointed_meanwhile() {
    let fixture = Fixture::new();
    stand_in(&fixture.bundled("Pilo.app"), "0.5.2");
    let other = fixture.root.join("elsewhere/pilo");
    stand_in(&other, "9.9.9");
    let link = fixture.system_link();
    let repointed = other.clone();
    let installer = fixture.elevating_installer("Pilo.app", move || {
        std::fs::set_permissions(
            link.parent().unwrap(),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        std::fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink(&repointed, &link).unwrap();
    });
    installer.install(false).unwrap();
    fixture.lock_system(true);
    let status = installer.uninstall().unwrap();
    fixture.lock_system(false);
    assert_eq!(status.outcome, Some("conflict"));
    assert_eq!(std::fs::read_link(fixture.system_link()).unwrap(), other);
}

#[test]
fn appimage_never_overwrites_an_unknown_copy() {
    let fixture = Fixture::new();
    stand_in(&fixture.bundled("mount"), "0.5.2");
    let copy = fixture.root.join("home/.local/share/pilo/bin/pilo");
    std::fs::create_dir_all(copy.parent().unwrap()).unwrap();
    std::fs::write(&copy, "someone else").unwrap();
    let installer = fixture.installer("mount", false, true);

    assert_eq!(installer.status().state, "conflict");
    let status = installer.install(false).unwrap();
    assert_eq!(status.outcome, Some("conflict"));
    assert_eq!(status.conflict_path.as_deref(), Some(copy.as_path()));
    assert_eq!(std::fs::read_to_string(&copy).unwrap(), "someone else");
    assert!(!fixture.system_link().exists());
}

#[test]
fn appimage_never_runs_replaces_or_removes_a_changed_copy() {
    let fixture = Fixture::new();
    stand_in(&fixture.bundled("mount"), "0.5.2");
    let installer = fixture.installer("mount", false, true);
    installer.install(false).unwrap();
    let copy = fixture.root.join("home/.local/share/pilo/bin/pilo");
    let ran = fixture.root.join("ran");
    std::fs::write(&copy, format!("#!/bin/sh\ntouch '{}'\n", ran.display())).unwrap();
    std::fs::set_permissions(&copy, std::fs::Permissions::from_mode(0o755)).unwrap();
    stand_in(&fixture.bundled("mount"), "0.6.0");

    let status = installer.status();
    assert_eq!(status.state, "conflict");
    assert_eq!(status.conflict_path.as_deref(), Some(copy.as_path()));
    assert!(!installer.sync_on_launch().unwrap());
    assert_eq!(installer.install(true).unwrap().outcome, Some("conflict"));
    installer.uninstall().unwrap();
    assert!(copy.exists());
    assert!(!ran.exists());
}

#[test]
fn path_edits_touch_only_the_segment_pilo_inserted() {
    let value = r" C:\Tools ;;C:\Apps\Pilo\bin\;";
    let mut segments = path_segments(value);
    insert_path_entry(&mut segments, r"C:\Apps\Pilo\bin");
    assert_eq!(
        segments.join(";"),
        r" C:\Tools ;;C:\Apps\Pilo\bin\;C:\Apps\Pilo\bin;"
    );
    assert!(remove_path_entry(&mut segments, r"C:\Apps\Pilo\bin"));
    assert_eq!(segments.join(";"), value);
    assert!(!remove_path_entry(&mut segments, r"C:\Apps\Pilo\bin"));
    assert!(path_segments("").is_empty());
}

fn locked_install_meets(fixture: &Fixture, occupy: fn(&Path, &Path)) {
    stand_in(&fixture.bundled("Pilo.app"), "0.5.2");
    let link = fixture.system_link();
    let elsewhere = fixture.root.join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let installer = fixture.elevating_installer("Pilo.app", move || {
        std::fs::set_permissions(
            link.parent().unwrap(),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        occupy(&link, &elsewhere);
    });
    fixture.lock_system(true);
    let status = installer.install(false).unwrap();
    fixture.lock_system(false);
    assert_eq!(status.outcome, Some("conflict"));
    assert!(installer.load_record().is_none());
}

#[test]
fn authorized_install_never_links_into_a_directory_created_meanwhile() {
    let fixture = Fixture::new();
    locked_install_meets(&fixture, |link, _| std::fs::create_dir(link).unwrap());
    assert_eq!(std::fs::read_dir(fixture.system_link()).unwrap().count(), 0);
}

#[test]
fn authorized_install_never_follows_a_directory_link_created_meanwhile() {
    let fixture = Fixture::new();
    locked_install_meets(&fixture, |link, elsewhere| {
        std::os::unix::fs::symlink(elsewhere, link).unwrap()
    });
    let elsewhere = fixture.root.join("elsewhere");
    assert_eq!(
        std::fs::read_link(fixture.system_link()).unwrap(),
        elsewhere
    );
    assert_eq!(std::fs::read_dir(elsewhere).unwrap().count(), 0);
}

#[test]
fn an_existing_link_to_the_bundled_cli_is_not_claimed() {
    let fixture = Fixture::new();
    stand_in(&fixture.bundled("Pilo.app"), "0.5.2");
    std::fs::create_dir_all(fixture.root.join("system")).unwrap();
    std::os::unix::fs::symlink(fixture.bundled("Pilo.app"), fixture.system_link()).unwrap();
    let installer = fixture.installer("Pilo.app", false, false);

    assert_eq!(installer.status().state, "conflict");
    assert_eq!(installer.install(false).unwrap().outcome, Some("conflict"));
    assert!(installer.load_record().is_none());
    installer.uninstall().unwrap();
    assert_eq!(
        std::fs::read_link(fixture.system_link()).unwrap(),
        fixture.bundled("Pilo.app")
    );
}

#[test]
fn new_files_are_placed_without_replacing_anything() {
    let fixture = Fixture::new();
    let path = fixture.root.join("copy");
    assert!(write_new(&path, b"first", true).unwrap());
    assert!(!write_new(&path, b"second", true).unwrap());
    assert_eq!(std::fs::read(&path).unwrap(), b"first");
    assert_eq!(std::fs::read_dir(&fixture.root).unwrap().count(), 1);
}
