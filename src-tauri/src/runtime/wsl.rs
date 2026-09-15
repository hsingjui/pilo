use std::{collections::HashSet, time::Duration};

use serde::Serialize;
use thiserror::Error;
use tokio::{process::Command, time::timeout};

use crate::domain::WslDistribution;

const WSL_PROGRAM: &str = "wsl.exe";
const WSL_LIST_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WslConnectionErrorCode {
    WslUnavailable,
    DistroListFailed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Error)]
#[error("{message}")]
#[serde(rename_all = "camelCase")]
pub struct WslConnectionError {
    pub code: WslConnectionErrorCode,
    pub message: String,
}

impl WslConnectionError {
    fn new(code: WslConnectionErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub async fn list_wsl_distributions() -> Result<Vec<WslDistribution>, WslConnectionError> {
    let output = timeout(
        WSL_LIST_TIMEOUT,
        Command::new(WSL_PROGRAM)
            .args(["--list", "--quiet"])
            .output(),
    )
    .await
    .map_err(|_| {
        WslConnectionError::new(
            WslConnectionErrorCode::DistroListFailed,
            "timed out while listing WSL distributions",
        )
    })?
    .map_err(|error| {
        WslConnectionError::new(
            WslConnectionErrorCode::WslUnavailable,
            format!("failed to run '{WSL_PROGRAM} --list --quiet': {error}"),
        )
    })?;

    if !output.status.success() {
        let stderr = decode_wsl_text(&output.stderr);
        return Err(WslConnectionError::new(
            WslConnectionErrorCode::DistroListFailed,
            format_command_failure("WSL distro list", output.status.to_string(), &stderr),
        ));
    }

    Ok(parse_wsl_distribution_list(&output.stdout))
}

fn parse_wsl_distribution_list(bytes: &[u8]) -> Vec<WslDistribution> {
    let text = decode_wsl_text(bytes);
    let mut seen = HashSet::new();
    text.lines()
        .map(str::trim)
        .map(|line| line.trim_start_matches('\u{feff}').trim())
        .filter(|line| !line.is_empty())
        .filter(|line| seen.insert((*line).to_owned()))
        .map(|name| WslDistribution {
            name: name.to_owned(),
        })
        .collect()
}

fn decode_wsl_text(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }

    let looks_utf16_le =
        bytes.len() >= 2 && (bytes.starts_with(&[0xff, 0xfe]) || bytes.contains(&0));
    if looks_utf16_le {
        let offset = usize::from(bytes.starts_with(&[0xff, 0xfe])) * 2;
        let (pairs, _) = bytes[offset..].as_chunks::<2>();
        let units = pairs
            .iter()
            .copied()
            .map(u16::from_le_bytes)
            .collect::<Vec<_>>();
        return String::from_utf16_lossy(&units)
            .trim_matches('\0')
            .to_owned();
    }

    String::from_utf8_lossy(bytes)
        .trim_start_matches('\u{feff}')
        .trim_matches('\0')
        .to_owned()
}

fn format_command_failure(label: &str, status: String, stderr: &str) -> String {
    if stderr.trim().is_empty() {
        format!("{label} exited with {status}")
    } else {
        format!("{label} exited with {status}: {}", stderr.trim())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_utf16le_wsl_distribution_output() {
        let text = "Debian\r\nUbuntu-24.04\r\n";
        let bytes = text
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();

        assert_eq!(
            parse_wsl_distribution_list(&bytes),
            vec![
                WslDistribution {
                    name: "Debian".to_owned()
                },
                WslDistribution {
                    name: "Ubuntu-24.04".to_owned()
                }
            ]
        );
    }

    #[test]
    fn parses_utf8_wsl_distribution_output_and_deduplicates() {
        let distributions = parse_wsl_distribution_list(b"Debian\n\nDebian\nUbuntu\n");
        assert_eq!(
            distributions,
            vec![
                WslDistribution {
                    name: "Debian".to_owned()
                },
                WslDistribution {
                    name: "Ubuntu".to_owned()
                }
            ]
        );
    }
}
