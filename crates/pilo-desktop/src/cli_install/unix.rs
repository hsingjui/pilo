//! Symlink entries on macOS and Linux.

use std::{
    io::ErrorKind,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use super::{
    ElevateError, Installer, Record, Status, cli_version, run_with_timeout, same_path,
    write_atomically,
};

const PATH_MARKER: &str = "__PILO_PATH__";

/// The PATH a new terminal gets: the login shell's, since a GUI app launched
/// from Finder or a desktop menu inherits a minimal one.
pub(crate) fn terminal_path_dirs() -> Vec<PathBuf> {
    let shell = std::env::var_os("SHELL")
        .filter(|shell| !shell.is_empty())
        .unwrap_or_else(|| "/bin/sh".into());
    let script = format!("echo {PATH_MARKER}; printenv PATH; echo {PATH_MARKER}");
    for flags in ["-ilc", "-lc"] {
        let output = run_with_timeout(
            Command::new(&shell).args([flags, script.as_str()]),
            Duration::from_secs(3),
        );
        if let Some(path) = output.as_deref().and_then(between_markers) {
            return std::env::split_paths(path).collect();
        }
    }
    std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default()
}

fn between_markers(output: &str) -> Option<&str> {
    let (_, rest) = output.split_once(PATH_MARKER)?;
    let (path, _) = rest.split_once(PATH_MARKER)?;
    let path = path.trim();
    (!path.is_empty()).then_some(path)
}

/// Runs a shell script as administrator after the system authorization prompt.
#[cfg(target_os = "macos")]
pub(crate) fn elevate(script: &str) -> Result<(), ElevateError> {
    let escaped = script.replace('\\', "\\\\").replace('"', "\\\"");
    let output = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(format!(
            "do shell script \"{escaped}\" with administrator privileges"
        ))
        .output()
        .map_err(|error| ElevateError::Failed(format!("could not run osascript: {error}")))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("(-128)") {
        Err(ElevateError::Canceled)
    } else {
        Err(ElevateError::Failed(stderr.trim().to_owned()))
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn elevate(_: &str) -> Result<(), ElevateError> {
    Err(ElevateError::Failed(
        "administrator authorization is only used on macOS".into(),
    ))
}

pub(crate) fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

#[derive(Debug, PartialEq, Eq)]
enum Occupant {
    Missing,
    /// A symlink to `expected` (what Pilo created or wants to create).
    Ours,
    Foreign,
}

fn occupant(path: &Path, expected: &[&Path]) -> Occupant {
    match std::fs::read_link(path) {
        Ok(target) if expected.iter().any(|expected| *expected == target) => Occupant::Ours,
        Ok(_) => Occupant::Foreign,
        Err(_) if std::fs::symlink_metadata(path).is_err() => Occupant::Missing,
        Err(_) => Occupant::Foreign,
    }
}

enum LinkError {
    Canceled,
    Failed(String),
}

impl Installer {
    /// What the entry should point at: the AppImage copy or the bundled CLI.
    fn desired_target(&self) -> Option<PathBuf> {
        match &self.copy_dir {
            Some(dir) => Some(dir.join(&self.command)),
            None => self.bundled.clone(),
        }
    }

    fn default_link(&self) -> PathBuf {
        self.system_dir
            .as_ref()
            .unwrap_or(&self.user_dir)
            .join(&self.command)
    }

    pub(super) fn check_default_conflict(&self, status: &mut Status) {
        if status.state != "not_installed" {
            return;
        }
        let link = self.default_link();
        let target = self.desired_target();
        let expected: Vec<&Path> = target.iter().map(PathBuf::as_path).collect();
        if occupant(&link, &expected) == Occupant::Foreign {
            status.state = "conflict";
            status.conflict_path = Some(link);
        }
    }

    pub(super) fn record_status(&self, record: &Record, status: &mut Status) {
        let Some(link) = record.link.clone() else {
            status.state = "stale";
            status.reason = Some("missing");
            return;
        };
        status.entry_path = Some(link.clone());
        status.path_dir = link.parent().map(Path::to_path_buf);
        let recorded: Vec<&Path> = record.link_target.iter().map(PathBuf::as_path).collect();
        match occupant(&link, &recorded) {
            Occupant::Missing => {
                status.state = "stale";
                status.reason = Some("missing");
                return;
            }
            Occupant::Foreign => {
                status.state = "conflict";
                status.conflict_path = Some(link);
                status.entry_target =
                    std::fs::read_link(status.conflict_path.as_ref().unwrap()).ok();
                return;
            }
            Occupant::Ours => {}
        }
        status.entry_target = record.link_target.clone();
        status.installed_version = cli_version(&link);
        let target = record.link_target.as_deref().unwrap_or(&link);
        status.reason = if !target.exists() {
            Some("moved")
        } else if !self.same_installation(record) {
            Some("other_app")
        } else if self
            .desired_target()
            .is_none_or(|desired| !same_path(&desired, target))
        {
            Some("moved")
        } else if status.installed_version.is_some()
            && status.bundled_version.is_some()
            && status.installed_version != status.bundled_version
        {
            Some("outdated")
        } else {
            None
        };
        if status.reason.is_some() {
            status.state = "stale";
            return;
        }
        let dir = link.parent().unwrap_or(Path::new("/"));
        status.state = if self.in_path(dir) {
            "ready"
        } else {
            "not_in_path"
        };
        status.shadowed_by = self.shadowing(dir);
    }

    fn write_copy(&self, bundled: &Path) -> Result<Option<PathBuf>, String> {
        let Some(dir) = &self.copy_dir else {
            return Ok(None);
        };
        std::fs::create_dir_all(dir)
            .map_err(|error| format!("creating {dir:?} failed: {error}"))?;
        let copy = dir.join(&self.command);
        let bytes = std::fs::read(bundled)
            .map_err(|error| format!("reading {bundled:?} failed: {error}"))?;
        write_atomically(&copy, &bytes, true)?;
        Ok(Some(copy))
    }

    /// Creates or replaces the link, asking for authorization when its directory is not writable.
    fn link(&self, link: &Path, target: &Path, replace: bool) -> Result<(), LinkError> {
        let direct = (|| {
            if let Some(parent) = link.parent() {
                std::fs::create_dir_all(parent)?;
            }
            if replace {
                std::fs::remove_file(link)?;
            }
            std::os::unix::fs::symlink(target, link)
        })();
        match direct {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::PermissionDenied => {
                let parent = link.parent().unwrap_or(Path::new("/"));
                let script = format!(
                    "mkdir -p {} && ln -sfn {} {}",
                    shell_quote(parent),
                    shell_quote(target),
                    shell_quote(link)
                );
                (self.elevate)(&script).map_err(|error| match error {
                    ElevateError::Canceled => LinkError::Canceled,
                    ElevateError::Failed(message) => LinkError::Failed(message),
                })
            }
            Err(error) => Err(LinkError::Failed(format!(
                "linking {link:?} to {target:?} failed: {error}"
            ))),
        }
    }

    fn unlink(&self, link: &Path) -> Result<(), LinkError> {
        match std::fs::remove_file(link) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) if error.kind() == ErrorKind::PermissionDenied => {
                let quoted = shell_quote(link);
                (self.elevate)(&format!("if [ -L {quoted} ]; then rm -f {quoted}; fi")).map_err(
                    |error| match error {
                        ElevateError::Canceled => LinkError::Canceled,
                        ElevateError::Failed(message) => LinkError::Failed(message),
                    },
                )
            }
            Err(error) => Err(LinkError::Failed(format!(
                "removing {link:?} failed: {error}"
            ))),
        }
    }

    fn finish(&self, outcome: &'static str) -> Status {
        let mut status = self.status();
        status.outcome = Some(outcome);
        status
    }

    pub(super) fn install(&self, repair: bool) -> Result<Status, String> {
        let bundled = self
            .bundled
            .clone()
            .ok_or("this Pilo build does not include the CLI")?;
        let record = self.load_record();
        let recorded_target: Vec<&Path> = record
            .iter()
            .filter_map(|record| record.link_target.as_deref())
            .collect();
        let target = self.desired_target().unwrap_or_else(|| bundled.clone());
        let mut candidates = match record.as_ref().and_then(|record| record.link.clone()) {
            Some(link) => vec![link],
            None => vec![self.default_link()],
        };
        // Only a fresh install from /usr/local/bin falls back to ~/.local/bin.
        if !repair && record.is_none() && self.system_dir.is_some() {
            candidates.push(self.user_dir.join(&self.command));
        }
        for (index, link) in candidates.iter().enumerate() {
            let mut expected = recorded_target.clone();
            expected.push(&target);
            let occupied = occupant(link, &expected);
            if occupied == Occupant::Foreign {
                let mut status = self.status();
                status.state = "conflict";
                status.conflict_path = Some(link.clone());
                status.outcome = Some("conflict");
                return Ok(status);
            }
            let copy = self.write_copy(&bundled)?;
            let up_to_date = std::fs::read_link(link).is_ok_and(|current| current == target);
            if !up_to_date {
                match self.link(link, &target, occupied == Occupant::Ours) {
                    Ok(()) => {}
                    Err(LinkError::Canceled) if index + 1 < candidates.len() => continue,
                    Err(LinkError::Canceled) => return Ok(self.finish("canceled")),
                    Err(LinkError::Failed(message)) => return Err(message),
                }
            }
            self.save_record(&Record {
                link: Some(link.clone()),
                link_target: Some(target.clone()),
                copy,
                path_entry: link.parent().map(Path::to_path_buf),
                path_entry_added: false,
                installation: self.installation.clone(),
            })?;
            return Ok(self.finish(if index == 0 { "installed" } else { "fallback" }));
        }
        Ok(self.finish("canceled"))
    }

    pub(super) fn uninstall(&self) -> Result<Status, String> {
        let Some(record) = self.load_record() else {
            return Ok(self.finish("uninstalled"));
        };
        if let Some(link) = &record.link {
            let recorded: Vec<&Path> = record.link_target.iter().map(PathBuf::as_path).collect();
            if occupant(link, &recorded) == Occupant::Ours {
                match self.unlink(link) {
                    Ok(()) => {}
                    Err(LinkError::Canceled) => return Ok(self.finish("canceled")),
                    Err(LinkError::Failed(message)) => return Err(message),
                }
            }
        }
        if let Some(copy) = &record.copy
            && std::fs::symlink_metadata(copy).is_ok_and(|metadata| metadata.is_file())
        {
            std::fs::remove_file(copy)
                .map_err(|error| format!("removing {copy:?} failed: {error}"))?;
        }
        self.clear_record()?;
        Ok(self.finish("uninstalled"))
    }

    pub(super) fn sync_on_launch(&self) -> Result<bool, String> {
        let (Some(record), Some(bundled)) = (self.load_record(), self.bundled.as_deref()) else {
            return Ok(false);
        };
        let (Some(copy), Some(link)) = (&record.copy, &record.link) else {
            return Ok(false);
        };
        if self.copy_dir.is_none() || !self.same_installation(&record) {
            return Ok(false);
        }
        let recorded: Vec<&Path> = record.link_target.iter().map(PathBuf::as_path).collect();
        if occupant(link, &recorded) != Occupant::Ours {
            return Ok(false);
        }
        let current = cli_version(copy);
        if current.is_some() && current == cli_version(bundled) {
            return Ok(false);
        }
        let bytes = std::fs::read(bundled)
            .map_err(|error| format!("reading {bundled:?} failed: {error}"))?;
        write_atomically(copy, &bytes, true)?;
        Ok(true)
    }
}
