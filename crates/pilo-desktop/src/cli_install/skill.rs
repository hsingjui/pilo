//! Installs, updates and removes the bundled `pilo-cli` agent skill copy in
//! `~/.agents/skills/pilo-cli/SKILL.md`.
//!
//! No automatic install or update happens on launch. Ownership is tracked by
//! file fingerprint so user-edited or third-party files are never overwritten
//! or removed.

use std::{
    io::ErrorKind,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use super::{DEV_APP_ID, Fingerprint, RELEASE_APP_ID, data_base, write_atomically, write_new};

pub(crate) const SKILL_NAME: &str = "pilo-cli";
const SKILL_CONTENT: &str = include_str!("../../../../skills/pilo-cli/SKILL.md");
const SKILL_RECORD_FILE: &str = "cli-skill-install.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillRecord {
    fingerprint: Fingerprint,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillStatus {
    pub name: &'static str,
    /// `not_installed`, `ready`, `outdated` or `conflict`.
    pub state: &'static str,
    pub path: PathBuf,
    /// Set by actions: `installed`, `updated`, `uninstalled` or `conflict`.
    pub outcome: Option<&'static str>,
}

pub(crate) struct SkillInstaller {
    pub target_path: PathBuf,
    /// Record paths checked for ownership; index 0 is written by this app.
    pub record_paths: Vec<PathBuf>,
    pub content: &'static [u8],
}

impl SkillInstaller {
    pub(crate) fn current(app_id: &str) -> Result<Self, String> {
        if app_id != RELEASE_APP_ID && app_id != DEV_APP_ID {
            return Err(format!("unknown Pilo app ID: {app_id}"));
        }
        let home = std::env::home_dir().ok_or("cannot resolve the home directory")?;
        let data = data_base(&home).ok_or("cannot resolve the Pilo data directory")?;
        let other_app_id = if app_id == RELEASE_APP_ID {
            DEV_APP_ID
        } else {
            RELEASE_APP_ID
        };
        Ok(Self {
            target_path: home
                .join(".agents")
                .join("skills")
                .join(SKILL_NAME)
                .join("SKILL.md"),
            record_paths: vec![
                data.join(app_id).join(SKILL_RECORD_FILE),
                data.join(other_app_id).join(SKILL_RECORD_FILE),
            ],
            content: SKILL_CONTENT.as_bytes(),
        })
    }

    pub(crate) fn status(&self) -> SkillStatus {
        self.status_with_outcome(None)
    }

    pub(crate) fn install(&self) -> Result<SkillStatus, String> {
        let bundled = Fingerprint::of_bytes(self.content);
        match std::fs::symlink_metadata(&self.target_path) {
            Err(error) if error.kind() == ErrorKind::NotFound => {
                if let Some(parent) = self.target_path.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|err| format!("creating {parent:?} failed: {err}"))?;
                }
                if write_new(&self.target_path, self.content, false)? {
                    self.save_record(&bundled)?;
                    Ok(self.make_status("ready", Some("installed")))
                } else {
                    let current = self.status();
                    let outcome = if current.state == "ready" {
                        self.save_record(&bundled)?;
                        Some("installed")
                    } else {
                        Some("conflict")
                    };
                    Ok(SkillStatus { outcome, ..current })
                }
            }
            Ok(metadata) if metadata.is_file() => {
                if Fingerprint::of_file(&self.target_path).as_ref() == Some(&bundled) {
                    self.save_record(&bundled)?;
                    Ok(self.make_status("ready", Some("installed")))
                } else {
                    Ok(self.status_with_outcome(Some("conflict")))
                }
            }
            Ok(_) => Ok(self.status_with_outcome(Some("conflict"))),
            Err(error) => Err(format!("checking {:?} failed: {error}", self.target_path)),
        }
    }

    pub(crate) fn update(&self) -> Result<SkillStatus, String> {
        let bundled = Fingerprint::of_bytes(self.content);
        let current = self.status();
        match current.state {
            "ready" => {
                self.save_record(&bundled)?;
                Ok(self.make_status("ready", Some("updated")))
            }
            "outdated" => {
                write_atomically(&self.target_path, self.content, false)?;
                self.save_record(&bundled)?;
                Ok(self.make_status("ready", Some("updated")))
            }
            "conflict" => Ok(SkillStatus {
                outcome: Some("conflict"),
                ..current
            }),
            _ => Ok(current),
        }
    }

    pub(crate) fn uninstall(&self) -> Result<SkillStatus, String> {
        let bundled = Fingerprint::of_bytes(self.content);
        match std::fs::symlink_metadata(&self.target_path) {
            Err(error) if error.kind() == ErrorKind::NotFound => {
                self.clear_records()?;
                Ok(self.make_status("not_installed", Some("uninstalled")))
            }
            Ok(metadata) if metadata.is_file() => {
                let disk = Fingerprint::of_file(&self.target_path);
                let owned = disk.as_ref() == Some(&bundled)
                    || disk.as_ref().is_some_and(|fp| self.matches_any_record(fp));
                if !owned {
                    return Ok(self.make_status("conflict", Some("conflict")));
                }
                match std::fs::remove_file(&self.target_path) {
                    Err(error) if error.kind() != ErrorKind::NotFound => {
                        return Err(format!("removing {:?} failed: {error}", self.target_path));
                    }
                    _ => {}
                }
                if let Some(parent) = self.target_path.parent() {
                    let _ = std::fs::remove_dir(parent);
                }
                self.clear_records()?;
                Ok(self.make_status("not_installed", Some("uninstalled")))
            }
            Ok(_) => Ok(self.make_status("conflict", Some("conflict"))),
            Err(error) => Err(format!("checking {:?} failed: {error}", self.target_path)),
        }
    }

    fn status_with_outcome(&self, outcome: Option<&'static str>) -> SkillStatus {
        let bundled = Fingerprint::of_bytes(self.content);
        let state = match std::fs::symlink_metadata(&self.target_path) {
            Err(error) if error.kind() == ErrorKind::NotFound => "not_installed",
            Ok(metadata) if metadata.is_file() => match Fingerprint::of_file(&self.target_path) {
                Some(disk) if disk == bundled => "ready",
                Some(disk) if self.matches_any_record(&disk) => "outdated",
                _ => "conflict",
            },
            _ => "conflict",
        };
        self.make_status(state, outcome)
    }

    fn make_status(&self, state: &'static str, outcome: Option<&'static str>) -> SkillStatus {
        SkillStatus {
            name: SKILL_NAME,
            state,
            path: self.target_path.clone(),
            outcome,
        }
    }

    fn matches_any_record(&self, fingerprint: &Fingerprint) -> bool {
        self.record_paths
            .iter()
            .filter_map(|path| read_record(path))
            .any(|record| &record.fingerprint == fingerprint)
    }

    fn save_record(&self, fingerprint: &Fingerprint) -> Result<(), String> {
        let Some(path) = self.record_paths.first() else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("creating {parent:?} failed: {error}"))?;
        }
        let bytes = serde_json::to_vec_pretty(&SkillRecord {
            fingerprint: fingerprint.clone(),
        })
        .map_err(|error| error.to_string())?;
        write_atomically(path, &bytes, false)
    }

    fn clear_records(&self) -> Result<(), String> {
        for path in &self.record_paths {
            match std::fs::remove_file(path) {
                Err(error) if error.kind() != ErrorKind::NotFound => {
                    return Err(format!("removing skill install record failed: {error}"));
                }
                _ => {}
            }
        }
        Ok(())
    }
}

fn read_record(path: &Path) -> Option<SkillRecord> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let unique = format!(
            "pilo-skill-test-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let dir = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn installer(root: &Path, content: &'static [u8]) -> SkillInstaller {
        SkillInstaller {
            target_path: root.join(".agents/skills/pilo-cli/SKILL.md"),
            record_paths: vec![
                root.join("data/release/cli-skill-install.json"),
                root.join("data/dev/cli-skill-install.json"),
            ],
            content,
        }
    }

    #[test]
    fn install_update_and_uninstall_lifecycle() {
        let root = temp_dir("lifecycle");
        let v1 = installer(&root, b"---\nname: pilo-cli\n---\nv1\n");

        assert_eq!(v1.status().state, "not_installed");

        let installed = v1.install().unwrap();
        assert_eq!(installed.state, "ready");
        assert_eq!(installed.outcome, Some("installed"));
        assert_eq!(
            std::fs::read(&v1.target_path).unwrap(),
            b"---\nname: pilo-cli\n---\nv1\n"
        );

        // Idempotent install keeps ready.
        let again = v1.install().unwrap();
        assert_eq!(again.state, "ready");
        assert_eq!(again.outcome, Some("installed"));

        // Newer bundled content shows outdated until explicitly updated.
        let v2 = installer(&root, b"---\nname: pilo-cli\n---\nv2\n");
        assert_eq!(v2.status().state, "outdated");

        let updated = v2.update().unwrap();
        assert_eq!(updated.state, "ready");
        assert_eq!(updated.outcome, Some("updated"));
        assert_eq!(
            std::fs::read(&v2.target_path).unwrap(),
            b"---\nname: pilo-cli\n---\nv2\n"
        );

        // Uninstall removes file and empty skill directory.
        let removed = v2.uninstall().unwrap();
        assert_eq!(removed.state, "not_installed");
        assert_eq!(removed.outcome, Some("uninstalled"));
        assert!(!v2.target_path.exists());
        assert!(!v2.target_path.parent().unwrap().exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn conflict_protects_user_modified_and_third_party_files() {
        let root = temp_dir("conflict");
        let v1 = installer(&root, b"v1");
        v1.install().unwrap();

        // User edits the file: status becomes conflict; update and uninstall leave it untouched.
        std::fs::write(&v1.target_path, b"custom user edits").unwrap();
        assert_eq!(v1.status().state, "conflict");

        let update_res = v1.update().unwrap();
        assert_eq!(update_res.state, "conflict");
        assert_eq!(update_res.outcome, Some("conflict"));
        assert_eq!(
            std::fs::read(&v1.target_path).unwrap(),
            b"custom user edits"
        );

        let uninstall_res = v1.uninstall().unwrap();
        assert_eq!(uninstall_res.state, "conflict");
        assert_eq!(uninstall_res.outcome, Some("conflict"));
        assert_eq!(
            std::fs::read(&v1.target_path).unwrap(),
            b"custom user edits"
        );

        let install_res = v1.install().unwrap();
        assert_eq!(install_res.state, "conflict");
        assert_eq!(install_res.outcome, Some("conflict"));
        assert_eq!(
            std::fs::read(&v1.target_path).unwrap(),
            b"custom user edits"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn uninstall_keeps_non_empty_skill_directory() {
        let root = temp_dir("non-empty");
        let v1 = installer(&root, b"v1");
        v1.install().unwrap();
        let extra = v1.target_path.parent().unwrap().join("notes.txt");
        std::fs::write(&extra, b"keep").unwrap();

        let removed = v1.uninstall().unwrap();
        assert_eq!(removed.state, "not_installed");
        assert!(!v1.target_path.exists());
        assert!(extra.exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn dev_and_release_share_ownership_records() {
        let root = temp_dir("shared-ownership");
        let release_v1 = SkillInstaller {
            target_path: root.join(".agents/skills/pilo-cli/SKILL.md"),
            record_paths: vec![
                root.join("data/release/cli-skill-install.json"),
                root.join("data/dev/cli-skill-install.json"),
            ],
            content: b"v1",
        };
        release_v1.install().unwrap();

        let dev_v2 = SkillInstaller {
            target_path: root.join(".agents/skills/pilo-cli/SKILL.md"),
            record_paths: vec![
                root.join("data/dev/cli-skill-install.json"),
                root.join("data/release/cli-skill-install.json"),
            ],
            content: b"v2",
        };
        assert_eq!(dev_v2.status().state, "outdated");
        assert_eq!(dev_v2.update().unwrap().state, "ready");
        assert_eq!(dev_v2.uninstall().unwrap().state, "not_installed");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn bundled_skill_is_non_empty_and_has_frontmatter() {
        assert!(SKILL_CONTENT.starts_with("---\nname: pilo-cli\n"));
        assert!(SKILL_CONTENT.contains("pilo sessions status"));
    }
}
