use std::{net::Ipv4Addr, time::Duration};

use tokio::process::Command;

const VIRTUAL_INTERFACE_PREFIXES: &[&str] = &[
    "lo",
    "utun",
    "tun",
    "tap",
    "docker",
    "br-",
    "veth",
    "virbr",
    "vmnet",
    "vboxnet",
    "tailscale",
    "wg",
    "zt",
    "awdl",
    "llw",
    "bridge",
    "anpi",
    "ap",
    "gif",
    "stf",
    "podman",
    "cni",
    "flannel",
    "kube",
];

fn is_usable_lan_ipv4(ip: Ipv4Addr) -> bool {
    !ip.is_loopback()
        && !ip.is_unspecified()
        && !ip.is_link_local()
        && !ip.is_multicast()
        && !ip.is_broadcast()
}

fn is_virtual_interface(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    lower.is_empty()
        || VIRTUAL_INTERFACE_PREFIXES
            .iter()
            .any(|prefix| lower.starts_with(prefix))
}

fn is_preferred_physical_interface(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    !is_virtual_interface(&lower)
        && (lower.starts_with("en")
            || lower.starts_with("eth")
            || lower.starts_with("wlan")
            || lower.starts_with("wlp")
            || lower.starts_with("wl")
            || lower.starts_with("em"))
}

fn interface_rank(name: &str) -> u8 {
    if is_preferred_physical_interface(name) {
        0
    } else if !is_virtual_interface(name) {
        1
    } else {
        2
    }
}

fn parse_macos_ifconfig(stdout: &str) -> Vec<(Ipv4Addr, u8)> {
    let mut current_iface = String::new();
    let mut results = Vec::new();
    for line in stdout.lines() {
        if !line.starts_with([' ', '\t'])
            && let Some((iface, _)) = line.split_once(':')
        {
            current_iface = iface.trim().to_owned();
            continue;
        }
        let mut words = line.split_whitespace();
        if words.next() != Some("inet") {
            continue;
        }
        let Some(ip) = words
            .next()
            .and_then(|raw| raw.split('/').next())
            .and_then(|raw| raw.parse::<Ipv4Addr>().ok())
        else {
            continue;
        };
        if is_usable_lan_ipv4(ip) {
            results.push((ip, interface_rank(&current_iface)));
        }
    }
    results
}

fn parse_linux_ip_addr(stdout: &str) -> Vec<(Ipv4Addr, u8)> {
    let mut results = Vec::new();
    for line in stdout.lines() {
        // Format: `2: eth0    inet 192.168.1.5/24 ...`
        let mut words = line.split_whitespace();
        let _index = words.next();
        let Some(iface) = words.next() else {
            continue;
        };
        let mut rest = words.skip_while(|word| *word != "inet");
        if rest.next() != Some("inet") {
            continue;
        }
        let Some(ip) = rest
            .next()
            .and_then(|raw| raw.split('/').next())
            .and_then(|raw| raw.parse::<Ipv4Addr>().ok())
        else {
            continue;
        };
        if is_usable_lan_ipv4(ip) {
            results.push((ip, interface_rank(iface)));
        }
    }
    results
}

fn parse_windows_output(stdout: &str) -> Vec<(Ipv4Addr, u8)> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut words = line.split_whitespace().skip_while(|word| *word != "inet");
            words.next()?;
            let ip = words.next()?.split('/').next()?.parse::<Ipv4Addr>().ok()?;
            let rank = if words.next() == Some("physical") {
                0
            } else {
                2
            };
            is_usable_lan_ipv4(ip).then_some((ip, rank))
        })
        .collect()
}

fn sort_and_dedup_ips(mut addresses: Vec<(Ipv4Addr, u8)>) -> Vec<Ipv4Addr> {
    // Deduplicate by IP, keeping the highest-priority (lowest rank) interface.
    addresses.sort_unstable();
    addresses.dedup_by_key(|(ip, _)| *ip);
    addresses.sort_unstable_by_key(|(ip, rank)| (*rank, !ip.is_private(), *ip));
    addresses.into_iter().map(|(ip, _)| ip).collect()
}

pub(crate) async fn list_lan_ips() -> Result<Vec<String>, String> {
    let mut command = if cfg!(windows) {
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$ErrorActionPreference = 'Stop'; \
             $physicalDescriptions = @(); \
             try { \
                 $physicalDescriptions = @(Get-NetAdapter -Physical -ErrorAction Stop | \
                     ForEach-Object { $_.InterfaceDescription }); \
             } catch {}; \
             [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | \
             Where-Object { $_.OperationalStatus -eq 'Up' } | \
             ForEach-Object { \
                 $kind = if ($physicalDescriptions -contains $_.Description) { 'physical' } else { 'other' }; \
                 $_.GetIPProperties().UnicastAddresses | \
                 Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' } | \
                 ForEach-Object { 'inet ' + $_.Address.ToString() + ' ' + $kind } \
             }",
        ]);
        command
    } else if cfg!(target_os = "macos") {
        let mut command = Command::new("ifconfig");
        command.arg("-u");
        command
    } else {
        let mut command = Command::new("ip");
        command.args(["-o", "-4", "addr", "show", "up"]);
        command
    };
    crate::hide_console_window(&mut command);
    command.kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(5), command.output())
        .await
        .map_err(|_| "timed out while listing LAN addresses".to_owned())?
        .map_err(|error| format!("failed to list LAN addresses: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "failed to list LAN addresses: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    // The Remote WebUI listener binds IPv4 only; do not advertise IPv6 targets.
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed = if cfg!(windows) {
        parse_windows_output(&stdout)
    } else if cfg!(target_os = "macos") {
        parse_macos_ifconfig(&stdout)
    } else {
        parse_linux_ip_addr(&stdout)
    };
    Ok(sort_and_dedup_ips(parsed)
        .into_iter()
        .map(|ip| ip.to_string())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_ifconfig_prefers_physical_en0_over_vpn_utun() {
        let sample = "\
lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
\tinet 127.0.0.1 netmask 0xff000000
utun4: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1500
\tinet 10.0.0.2 --> 10.0.0.2 netmask 0xffffffff
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tinet 192.168.1.42 netmask 0xffffff00 broadcast 192.168.1.255
bridge100: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tinet 192.168.64.1 netmask 0xffffff00 broadcast 192.168.64.255
";
        let sorted = sort_and_dedup_ips(parse_macos_ifconfig(sample));
        assert_eq!(
            sorted,
            vec![
                Ipv4Addr::new(192, 168, 1, 42),
                Ipv4Addr::new(10, 0, 0, 2),
                Ipv4Addr::new(192, 168, 64, 1),
            ]
        );
    }

    #[test]
    fn linux_ip_addr_prefers_eth_and_wlan_over_docker_and_tailscale() {
        let sample = "\
1: lo    inet 127.0.0.1/8 scope host lo
2: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0
3: tailscale0    inet 100.64.1.9/32 scope global tailscale0
4: wlp2s0    inet 192.168.31.88/24 brd 192.168.31.255 scope global dynamic wlp2s0
";
        let sorted = sort_and_dedup_ips(parse_linux_ip_addr(sample));
        assert_eq!(
            sorted,
            vec![
                Ipv4Addr::new(192, 168, 31, 88),
                Ipv4Addr::new(172, 17, 0, 1),
                Ipv4Addr::new(100, 64, 1, 9),
            ]
        );
    }
}
