//! The user PATH entry on Windows: the app's `bin` directory, never a `.cmd` shim.

use std::{
    path::{Path, PathBuf},
    ptr::{null, null_mut},
};

use windows_sys::Win32::{
    Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS},
    System::Registry::{
        HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_EXPAND_SZ,
        REG_VALUE_TYPE, RegCloseKey, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
    },
    UI::WindowsAndMessaging::{
        HWND_BROADCAST, SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_SETTINGCHANGE,
    },
};

use super::{
    Installer, Record, Status, cli_version, insert_path_entry, path_segments, remove_path_entry,
    same_path,
};

const USER_ENVIRONMENT: &str = "Environment";
const SYSTEM_ENVIRONMENT: &str = r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment";

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

struct Key(HKEY);

impl Drop for Key {
    fn drop(&mut self) {
        // SAFETY: the handle came from RegOpenKeyExW and is closed once.
        unsafe { RegCloseKey(self.0) };
    }
}

fn open_key(root: HKEY, path: &str, access: u32) -> Result<Key, String> {
    let mut key: HKEY = null_mut();
    let path = wide(path);
    // SAFETY: `path` is NUL-terminated and `key` receives the opened handle.
    let status = unsafe { RegOpenKeyExW(root, path.as_ptr(), 0, access, &mut key) };
    if status == ERROR_SUCCESS {
        Ok(Key(key))
    } else {
        Err(format!(
            "opening the environment registry key failed ({status})"
        ))
    }
}

/// The raw `Path` value and its registry type; empty when unset.
fn read_path(key: &Key) -> Result<(String, REG_VALUE_TYPE), String> {
    let name = wide("Path");
    let mut kind: REG_VALUE_TYPE = 0;
    let mut size = 0u32;
    // SAFETY: a null data pointer asks only for the size.
    let status = unsafe {
        RegQueryValueExW(
            key.0,
            name.as_ptr(),
            null(),
            &mut kind,
            null_mut(),
            &mut size,
        )
    };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok((String::new(), REG_EXPAND_SZ));
    }
    if status != ERROR_SUCCESS {
        return Err(format!("reading PATH failed ({status})"));
    }
    let mut buffer = vec![0u16; (size as usize).div_ceil(2) + 1];
    let mut size = (buffer.len() * 2) as u32;
    // SAFETY: `buffer` holds `size` bytes.
    let status = unsafe {
        RegQueryValueExW(
            key.0,
            name.as_ptr(),
            null(),
            &mut kind,
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(format!("reading PATH failed ({status})"));
    }
    let length = (size as usize / 2).min(buffer.len());
    let text = String::from_utf16_lossy(&buffer[..length]);
    Ok((text.trim_end_matches('\0').to_owned(), kind))
}

fn write_path(key: &Key, value: &str, kind: REG_VALUE_TYPE) -> Result<(), String> {
    let name = wide("Path");
    let data = wide(value);
    // SAFETY: `data` is a NUL-terminated UTF-16 string of the given byte length.
    let status = unsafe {
        RegSetValueExW(
            key.0,
            name.as_ptr(),
            0,
            kind,
            data.as_ptr().cast(),
            (data.len() * 2) as u32,
        )
    };
    if status == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(format!("writing the user PATH failed ({status})"))
    }
}

/// Tells Explorer and new terminals that the environment changed.
fn broadcast_environment_change() {
    let environment = wide(USER_ENVIRONMENT);
    // SAFETY: `environment` outlives the call; a hung window is skipped after the timeout.
    unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            0,
            environment.as_ptr() as isize,
            SMTO_ABORTIFHUNG,
            5000,
            null_mut(),
        )
    };
}

/// Expands `%NAME%` references the way new processes see them.
fn expand(entry: &str) -> String {
    let mut result = String::new();
    let mut rest = entry;
    while let Some(start) = rest.find('%') {
        let Some(length) = rest[start + 1..].find('%') else {
            break;
        };
        let name = &rest[start + 1..start + 1 + length];
        result.push_str(&rest[..start]);
        match std::env::var(name) {
            Ok(value) if !name.is_empty() => result.push_str(&value),
            _ => result.push_str(&rest[start..start + length + 2]),
        }
        rest = &rest[start + length + 2..];
    }
    result.push_str(rest);
    result
}

fn entries(value: &str) -> Vec<String> {
    value
        .split(';')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Compares a PATH segment with `dir` after normalizing whitespace, quotes and `%VAR%`s.
fn matches(entry: &str, dir: &Path) -> bool {
    let entry = expand(entry.trim());
    let entry = entry.trim_matches('"');
    !entry.is_empty() && same_path(Path::new(entry), dir)
}

fn system_path() -> String {
    open_key(HKEY_LOCAL_MACHINE, SYSTEM_ENVIRONMENT, KEY_QUERY_VALUE)
        .and_then(|key| read_path(&key))
        .map(|(value, _)| value)
        .unwrap_or_default()
}

/// The PATH a new terminal gets: the system PATH, then the user PATH.
pub(crate) fn terminal_path_dirs() -> Vec<PathBuf> {
    let user = open_key(HKEY_CURRENT_USER, USER_ENVIRONMENT, KEY_QUERY_VALUE)
        .and_then(|key| read_path(&key))
        .map(|(value, _)| value)
        .unwrap_or_default();
    entries(&system_path())
        .into_iter()
        .chain(entries(&user))
        .map(|entry| PathBuf::from(expand(&entry).trim_matches('"')))
        .collect()
}

impl Installer {
    pub(super) fn check_default_conflict(&self, _: &mut Status) {}

    pub(super) fn record_status(&self, record: &Record, status: &mut Status) {
        let Some(entry) = record.path_entry.clone() else {
            status.state = "stale";
            status.reason = Some("missing");
            return;
        };
        let executable = entry.join(&self.command);
        status.entry_path = Some(executable.clone());
        status.path_dir = Some(entry.clone());
        status.installed_version = cli_version(&executable);
        let current = self.bundled.as_deref().and_then(Path::parent);
        status.reason = if !executable.is_file() {
            Some("moved")
        } else if !self.same_installation(record) {
            Some("other_app")
        } else if current.is_none_or(|current| !same_path(current, &entry)) {
            Some("moved")
        } else if !self.in_path(&entry) {
            Some("path_removed")
        } else {
            None
        };
        if status.reason.is_some() {
            status.state = "stale";
            return;
        }
        status.state = "ready";
        status.shadowed_by = self.shadowing(&entry);
    }

    fn entry_shared(&self, entry: &Path) -> bool {
        self.other_records().iter().any(|record| {
            record
                .path_entry
                .as_deref()
                .is_some_and(|other| same_path(other, entry))
        })
    }

    pub(super) fn install(&self, _repair: bool) -> Result<Status, String> {
        let bundled = self
            .bundled
            .clone()
            .ok_or("this Pilo build does not include the CLI")?;
        let bin = bundled
            .parent()
            .ok_or("the bundled CLI has no directory")?
            .to_path_buf();
        let record = self.load_record();
        let key = open_key(
            HKEY_CURRENT_USER,
            USER_ENVIRONMENT,
            KEY_QUERY_VALUE | KEY_SET_VALUE,
        )?;
        let (value, kind) = read_path(&key)?;
        let mut user = path_segments(&value);
        let mut changed = false;
        // A moved or re-extracted app drops only the entry Pilo itself added.
        if let Some(record) = &record
            && record.path_entry_added
            && let (Some(old), Some(raw)) = (&record.path_entry, &record.path_entry_raw)
            && !same_path(old, &bin)
            && !self.entry_shared(old)
        {
            changed |= remove_path_entry(&mut user, raw);
        }
        let kept_raw = record
            .as_ref()
            .filter(|record| {
                record.path_entry_added
                    && record
                        .path_entry
                        .as_deref()
                        .is_some_and(|old| same_path(old, &bin))
            })
            .and_then(|record| record.path_entry_raw.clone())
            .filter(|raw| user.iter().any(|entry| entry == raw));
        let in_user = user.iter().any(|entry| matches(entry, &bin));
        let in_system = entries(&system_path())
            .iter()
            .any(|entry| matches(entry, &bin));
        let raw = if kept_raw.is_some() {
            kept_raw
        } else if in_user || in_system {
            None
        } else {
            let raw = bin.to_string_lossy().into_owned();
            insert_path_entry(&mut user, &raw);
            changed = true;
            Some(raw)
        };
        if changed {
            let kind = if kind == 0 { REG_EXPAND_SZ } else { kind };
            write_path(&key, &user.join(";"), kind)?;
            broadcast_environment_change();
        }
        self.save_record(&Record {
            link: None,
            link_target: None,
            copy: None,
            copy_fingerprint: None,
            path_entry: Some(bin),
            path_entry_added: raw.is_some(),
            path_entry_raw: raw,
            installation: self.installation.clone(),
        })?;
        let mut installer_status = self.status_after_path_change();
        installer_status.outcome = Some("installed");
        Ok(installer_status)
    }

    /// Re-reads PATH from the registry, since it just changed.
    fn status_after_path_change(&self) -> Status {
        let refreshed = Installer {
            app_id: self.app_id.clone(),
            command: self.command.clone(),
            bundled: self.bundled.clone(),
            installation: self.installation.clone(),
            data_base: self.data_base.clone(),
            path_dirs: terminal_path_dirs(),
            system_dir: None,
            user_dir: self.user_dir.clone(),
            copy_dir: None,
            elevate: Box::new(super::elevate),
        };
        refreshed.status()
    }

    pub(super) fn uninstall(&self) -> Result<Status, String> {
        if let Some(record) = self.load_record()
            && record.path_entry_added
            && let (Some(entry), Some(raw)) = (&record.path_entry, &record.path_entry_raw)
            && !self.entry_shared(entry)
        {
            let key = open_key(
                HKEY_CURRENT_USER,
                USER_ENVIRONMENT,
                KEY_QUERY_VALUE | KEY_SET_VALUE,
            )?;
            let (value, kind) = read_path(&key)?;
            let mut user = path_segments(&value);
            if remove_path_entry(&mut user, raw) {
                write_path(&key, &user.join(";"), kind)?;
                broadcast_environment_change();
            }
        }
        self.clear_record()?;
        let mut status = self.status_after_path_change();
        status.outcome = Some("uninstalled");
        Ok(status)
    }

    pub(super) fn sync_on_launch(&self) -> Result<bool, String> {
        Ok(false)
    }
}
