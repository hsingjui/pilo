use std::sync::OnceLock;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::host_api;

pub(super) fn host_name() -> &'static str {
    static HOST_NAME: OnceLock<String> = OnceLock::new();
    HOST_NAME
        .get_or_init(|| {
            for key in ["HOSTNAME", "COMPUTERNAME"] {
                if let Ok(value) = std::env::var(key) {
                    let trimmed = value.trim();
                    if !trimmed.is_empty() {
                        return trimmed.to_owned();
                    }
                }
            }
            #[cfg(unix)]
            if let Ok(output) = std::process::Command::new("hostname").output()
                && output.status.success()
                && let Ok(name) = String::from_utf8(output.stdout)
            {
                let trimmed = name.trim();
                if !trimmed.is_empty() {
                    return trimmed.to_owned();
                }
            }
            "Pilo Host".to_owned()
        })
        .as_str()
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

pub(crate) fn methods_hash() -> &'static str {
    static HASH: OnceLock<String> = OnceLock::new();
    HASH.get_or_init(|| {
        let mut hasher = Sha256::new();
        for spec in host_api::methods() {
            hasher.update(spec.name.as_bytes());
            hasher.update(b":");
            hasher.update(
                serde_json::to_string(&spec.scope)
                    .unwrap_or_default()
                    .as_bytes(),
            );
            hasher.update(b":");
            hasher.update(
                serde_json::to_string(&spec.kind)
                    .unwrap_or_default()
                    .as_bytes(),
            );
            hasher.update(b"\n");
        }
        let digest = hasher.finalize();
        let mut out = String::with_capacity(digest.len() * 2);
        for byte in digest {
            use std::fmt::Write;
            let _ = write!(&mut out, "{byte:02x}");
        }
        out
    })
    .as_str()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Capabilities<'a> {
    platform: &'static str,
    wsl: bool,
    methods: Vec<&'static str>,
    methods_hash: &'a str,
}

pub(crate) fn host_capabilities() -> Capabilities<'static> {
    Capabilities {
        platform: platform_name(),
        wsl: cfg!(target_os = "windows"),
        methods: host_api::methods().iter().map(|spec| spec.name).collect(),
        methods_hash: methods_hash(),
    }
}
