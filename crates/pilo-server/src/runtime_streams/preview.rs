use serde_json::Value;
use tokio::process::Command;

use crate::to_value;

pub(crate) async fn preview_ports() -> Result<Value, String> {
    if cfg!(windows) {
        let script = "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort | Sort-Object -Unique";
        let mut command = Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .kill_on_drop(true);
        let output = tokio::time::timeout(std::time::Duration::from_secs(3), command.output())
            .await
            .map_err(|_| "timed out while listing preview ports".to_owned())?
            .map_err(|error| error.to_string())?;
        let ports = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.trim().parse::<u16>().ok())
            .collect::<Vec<_>>();
        return to_value(ports);
    }
    let script = "if command -v ss >/dev/null 2>&1; then ss -ltnH | awk '{a=$4; sub(/^.*:/,\"\",a); if(a ~ /^[0-9]+$/) print a}' | sort -nu; elif command -v netstat >/dev/null 2>&1; then netstat -lnt 2>/dev/null | awk 'NR>2 {a=$4; sub(/^.*:/,\"\",a); if(a ~ /^[0-9]+$/) print a}' | sort -nu; fi";
    let mut command = Command::new("/bin/sh");
    command.args(["-c", script]).kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(3), command.output())
        .await
        .map_err(|_| "timed out while listing preview ports".to_owned())?
        .map_err(|error| error.to_string())?;
    let ports = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<u16>().ok())
        .collect::<Vec<_>>();
    to_value(ports)
}
