mod activity;
mod index;
mod io;
mod search;
mod watch;

use std::path::PathBuf;

pub(crate) use activity::session_activity;
pub(crate) use index::session_scan;
pub(crate) use io::{session_delete, session_discover, session_read};
pub(crate) use search::session_search;
pub(crate) use watch::{session_watch_start, session_watch_stop};

#[cfg(test)]
pub(crate) use index::{
    SESSION_INDEX_HEADER_BYTES, SESSION_INDEX_PREFIX_BYTES, SESSION_INDEX_TAIL_BYTES,
    summarize_session_index,
};
#[cfg(test)]
pub(crate) use watch::{collect_session_change_paths, is_session_change};

fn session_dir_key(project: &str) -> String {
    let normalized = project.trim().trim_start_matches(['/', '\\']);
    format!("--{}--", normalized.replace(['/', '\\', ':'], "-"))
}

fn agent_dir() -> Option<PathBuf> {
    std::env::var_os("PI_CODING_AGENT_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".pi/agent")))
        .or_else(|| {
            std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join(".pi/agent"))
        })
}
