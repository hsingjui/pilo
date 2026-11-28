//! Symlink entries on macOS and Linux.

use std::{
    io::ErrorKind,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use super::{
    ElevateError, Fingerprint, Installer, Record, Status, cli_version, run_with_timeout, same_path,
    write_atomically,
};

const PATH_MARKER: &str = "__PILO_PATH__";
/// Printed by an elevated script that found the entry changed.
const CONFLICT_MARKER: &str = "pilo-cli-conflict";

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
    } else if stderr.contains(CONFLICT_MARKER) {
        Err(ElevateError::Conflict)
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
    /// A symlink to one of the expected targets (what Pilo created or wants to create).
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

/// Whether the AppImage copy at `path` is the file Pilo wrote.
fn copy_occupant(path: &Path, written: Option<&Fingerprint>) -> Occupant {
    if std::fs::symlink_metadata(path).is_err() {
        return Occupant::Missing;
    }
    match (Fingerprint::of_file(path), written) {
        (Some(current), Some(written)) if current == *written => Occupant::Ours,
        _ => Occupant::Foreign,
    }
}

/// A shell test that the link at `link` still points at `expected`, or fails with the conflict marker.
fn expect_link(link: &Path, expected: &Path) -> String {
    format!(
        "if [ \"$(readlink {link})\" != {expected} ]; then echo {CONFLICT_MARKER} >&2; exit 3; fi",
        link = shell_quote(link),
        expected = shell_quote(expected),
    )
}

enum LinkError {
    Canceled,
    Conflict,
    Failed(String),
}

impl From<ElevateError> for LinkError {
    fn from(error: ElevateError) -> Self {
        match error {
            ElevateError::Canceled => Self::Canceled,
            ElevateError::Conflict => Self::Conflict,
            ElevateError::Failed(message) => Self::Failed(message),
        }
    }
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
        // Without a record, any file at the AppImage copy path is someone else's.
        if let Some(dir) = &self.copy_dir {
            let copy = dir.join(&self.command);
            if copy_occupant(&copy, None) != Occupant::Missing {
                status.state = "conflict";
                status.conflict_path = Some(copy);
                return;
            }
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
                status.entry_target = std::fs::read_link(&link).ok();
                status.state = "conflict";
                status.conflict_path = Some(link);
                return;
            }
            Occupant::Ours => {}
        }
        status.entry_target = record.link_target.clone();
        if let Some(copy) = &record.copy {
            match copy_occupant(copy, record.copy_fingerprint.as_ref()) {
                Occupant::Ours => {}
                Occupant::Missing => {
                    status.state = "stale";
                    status.reason = Some("missing");
                    return;
                }
                // Never run a file Pilo did not write.
                Occupant::Foreign => {
                    status.state = "conflict";
                    status.conflict_path = Some(copy.clone());
                    return;
                }
            }
        }
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

    /// Writes the AppImage copy unless a file Pilo did not write is in the way.
    /// `Err(Some(path))` is that conflict.
    #[allow(clippy::type_complexity)]
    fn write_copy(
        &self,
        bundled: &Path,
        record: Option<&Record>,
    ) -> Result<Option<(PathBuf, Fingerprint)>, Result<String, PathBuf>> {
        let Some(dir) = &self.copy_dir else {
            return Ok(None);
        };
        let copy = dir.join(&self.command);
        let written = record
            .filter(|record| record.copy.as_deref() == Some(copy.as_path()))
            .and_then(|record| record.copy_fingerprint.as_ref());
        if copy_occupant(&copy, written) == Occupant::Foreign {
            return Err(Err(copy));
        }
        std::fs::create_dir_all(dir)
            .map_err(|error| Ok(format!("creating {dir:?} failed: {error}")))?;
        let bytes = std::fs::read(bundled)
            .map_err(|error| Ok(format!("reading {bundled:?} failed: {error}")))?;
        write_atomically(&copy, &bytes, true).map_err(Ok)?;
        Ok(Some((copy, Fingerprint::of_bytes(&bytes))))
    }

    /// Creates the link, or replaces it if it still points at `replace`,
    /// asking for authorization when its directory is not writable. Never
    /// overwrites a file that appeared or changed meanwhile.
    fn link(&self, link: &Path, target: &Path, replace: Option<&Path>) -> Result<(), LinkError> {
        let direct = (|| {
            if let Some(parent) = link.parent() {
                std::fs::create_dir_all(parent)?;
            }
            if let Some(expected) = replace {
                if std::fs::read_link(link)? != expected {
                    return Err(std::io::Error::from(ErrorKind::AlreadyExists));
                }
                std::fs::remove_file(link)?;
            }
            std::os::unix::fs::symlink(target, link)
        })();
        match direct {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => Err(LinkError::Conflict),
            Err(error) if error.kind() == ErrorKind::PermissionDenied => {
                let parent = link.parent().unwrap_or(Path::new("/"));
                let script = match replace {
                    Some(expected) => format!(
                        "{} && ln -sfn {} {}",
                        expect_link(link, expected),
                        shell_quote(target),
                        shell_quote(link)
                    ),
                    // Without -f, ln fails if anything is already there.
                    None => format!(
                        "mkdir -p {} && if ! ln -s {} {}; then echo {CONFLICT_MARKER} >&2; exit 3; fi",
                        shell_quote(parent),
                        shell_quote(target),
                        shell_quote(link)
                    ),
                };
                (self.elevate)(&script).map_err(LinkError::from)
            }
            Err(error) => Err(LinkError::Failed(format!(
                "linking {link:?} to {target:?} failed: {error}"
            ))),
        }
    }

    /// Removes the link only while it still points at `expected`.
    fn unlink(&self, link: &Path, expected: &Path) -> Result<(), LinkError> {
        match std::fs::read_link(link) {
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
            Ok(current) if current != expected => return Err(LinkError::Conflict),
            Err(_) => return Err(LinkError::Conflict),
            Ok(_) => {}
        }
        match std::fs::remove_file(link) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) if error.kind() == ErrorKind::PermissionDenied => {
                let script = format!(
                    "{} && rm -f {}",
                    expect_link(link, expected),
                    shell_quote(link)
                );
                (self.elevate)(&script).map_err(LinkError::from)
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

    fn conflict(&self, path: PathBuf) -> Status {
        let mut status = self.status();
        status.state = "conflict";
        status.conflict_path = Some(path);
        status.outcome = Some("conflict");
        status
    }

    pub(super) fn install(&self, repair: bool) -> Result<Status, String> {
        let bundled = self
            .bundled
            .clone()
            .ok_or("this Pilo build does not include the CLI")?;
        let record = self.load_record();
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
            let current = std::fs::read_link(link).ok();
            let recorded = record
                .as_ref()
                .and_then(|record| record.link_target.as_deref());
            let mut expected: Vec<&Path> = recorded.into_iter().collect();
            expected.push(&target);
            if occupant(link, &expected) == Occupant::Foreign {
                return Ok(self.conflict(link.clone()));
            }
            let copy = match self.write_copy(&bundled, record.as_ref()) {
                Ok(copy) => copy,
                Err(Err(path)) => return Ok(self.conflict(path)),
                Err(Ok(message)) => return Err(message),
            };
            if current.as_deref() != Some(target.as_path()) {
                match self.link(link, &target, current.as_deref()) {
                    Ok(()) => {}
                    Err(LinkError::Canceled) if index + 1 < candidates.len() => continue,
                    Err(LinkError::Canceled) => return Ok(self.finish("canceled")),
                    Err(LinkError::Conflict) => return Ok(self.conflict(link.clone())),
                    Err(LinkError::Failed(message)) => return Err(message),
                }
            }
            let (copy, copy_fingerprint) = copy.unzip();
            self.save_record(&Record {
                link: Some(link.clone()),
                link_target: Some(target.clone()),
                copy,
                copy_fingerprint,
                path_entry: link.parent().map(Path::to_path_buf),
                path_entry_added: false,
                path_entry_raw: None,
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
        if let (Some(link), Some(expected)) = (&record.link, &record.link_target)
            && occupant(link, &[expected]) == Occupant::Ours
        {
            match self.unlink(link, expected) {
                Ok(()) => {}
                Err(LinkError::Canceled) => return Ok(self.finish("canceled")),
                Err(LinkError::Conflict) => return Ok(self.conflict(link.clone())),
                Err(LinkError::Failed(message)) => return Err(message),
            }
        }
        // A copy that is no longer the file Pilo wrote is left alone.
        if let Some(copy) = &record.copy
            && copy_occupant(copy, record.copy_fingerprint.as_ref()) == Occupant::Ours
        {
            std::fs::remove_file(copy)
                .map_err(|error| format!("removing {copy:?} failed: {error}"))?;
        }
        self.clear_record()?;
        Ok(self.finish("uninstalled"))
    }

    pub(super) fn sync_on_launch(&self) -> Result<bool, String> {
        let (Some(mut record), Some(bundled)) = (self.load_record(), self.bundled.as_deref())
        else {
            return Ok(false);
        };
        let (Some(copy), Some(link), Some(target)) =
            (record.copy.clone(), &record.link, &record.link_target)
        else {
            return Ok(false);
        };
        if self.copy_dir.is_none()
            || !self.same_installation(&record)
            || occupant(link, &[target]) != Occupant::Ours
            || copy_occupant(&copy, record.copy_fingerprint.as_ref()) != Occupant::Ours
        {
            return Ok(false);
        }
        let current = cli_version(&copy);
        if current.is_some() && current == cli_version(bundled) {
            return Ok(false);
        }
        let bytes = std::fs::read(bundled)
            .map_err(|error| format!("reading {bundled:?} failed: {error}"))?;
        // The copy may have changed while its version ran.
        if copy_occupant(&copy, record.copy_fingerprint.as_ref()) != Occupant::Ours {
            return Ok(false);
        }
        write_atomically(&copy, &bytes, true)?;
        record.copy_fingerprint = Some(Fingerprint::of_bytes(&bytes));
        self.save_record(&record)?;
        Ok(true)
    }
}
