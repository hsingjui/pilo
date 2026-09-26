use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum ServerPlatform {
    Windows,
    Linux,
    Darwin,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum ServerArch {
    X86_64,
    Aarch64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct ServerTarget {
    pub(crate) platform: ServerPlatform,
    pub(crate) arch: ServerArch,
}

impl ServerTarget {
    pub(crate) fn resource_name(self) -> Result<&'static str, String> {
        match (self.platform, self.arch) {
            (ServerPlatform::Windows, ServerArch::X86_64) => Ok("pilo-server-windows-x86_64.exe"),
            (ServerPlatform::Linux, ServerArch::X86_64) => Ok("pilo-server-linux-x86_64"),
            (ServerPlatform::Linux, ServerArch::Aarch64) => Ok("pilo-server-linux-aarch64"),
            (ServerPlatform::Darwin, ServerArch::Aarch64) => Ok("pilo-server-darwin-aarch64"),
            (platform, arch) => Err(format!(
                "pilo-server runtime is not bundled for {platform:?} {arch:?}"
            )),
        }
    }

    fn from_uname(os: &str, arch: &str) -> Result<Self, String> {
        let platform = match os.trim().to_ascii_lowercase().as_str() {
            "linux" => ServerPlatform::Linux,
            "darwin" => ServerPlatform::Darwin,
            other => {
                return Err(format!(
                    "remote operating system '{other}' is not supported"
                ));
            }
        };
        let arch = parse_server_arch(arch)?;
        let target = Self { platform, arch };
        target.resource_name()?;
        Ok(target)
    }

    pub(crate) fn current() -> Result<Self, String> {
        let platform = if cfg!(target_os = "windows") {
            ServerPlatform::Windows
        } else if cfg!(target_os = "linux") {
            ServerPlatform::Linux
        } else if cfg!(target_os = "macos") {
            ServerPlatform::Darwin
        } else {
            return Err(format!(
                "Pilo server is not bundled for host operating system '{}'",
                std::env::consts::OS
            ));
        };
        let arch = parse_server_arch(std::env::consts::ARCH)?;
        let target = Self { platform, arch };
        target.resource_name()?;
        Ok(target)
    }
}

fn parse_server_arch(arch: &str) -> Result<ServerArch, String> {
    match arch.trim().to_ascii_lowercase().as_str() {
        "x86_64" | "amd64" | "x64" => Ok(ServerArch::X86_64),
        "aarch64" | "arm64" => Ok(ServerArch::Aarch64),
        other => Err(format!("server architecture '{other}' is not supported")),
    }
}

pub(crate) fn parse_target_probe(output: &[u8], label: &str) -> Result<ServerTarget, String> {
    let output = String::from_utf8_lossy(output);
    let (os, arch) = output.trim().split_once('\t').ok_or_else(|| {
        format!(
            "invalid {label} platform probe response: '{}'",
            output.trim()
        )
    })?;
    ServerTarget::from_uname(os, arch)
}

pub(crate) fn installed_server_candidates(exe: &Path, resource_name: &str) -> Vec<PathBuf> {
    let Some(dir) = exe.parent() else {
        return Vec::new();
    };

    let mut candidates = vec![
        dir.join("runtime").join(resource_name),
        dir.join("../Resources/runtime").join(resource_name),
    ];
    if let Some(exe_name) = exe.file_stem().and_then(|name| name.to_str()) {
        candidates.push(
            dir.join("../lib")
                .join(exe_name)
                .join("runtime")
                .join(resource_name),
        );
    }
    candidates
}

pub(crate) fn server_binary(target: ServerTarget) -> Result<PathBuf, String> {
    let resource_name = target.resource_name()?;
    if let Some(path) = std::env::var_os("PILO_SERVER_PATH")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        return Ok(path);
    }
    if target.platform == ServerPlatform::Linux
        && target.arch == ServerArch::X86_64
        && let Some(path) = std::env::var_os("PILO_SERVER_LINUX_PATH")
            .map(PathBuf::from)
            .filter(|path| path.is_file())
    {
        return Ok(path);
    }

    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        candidates.extend(installed_server_candidates(&exe, resource_name));
    }
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    candidates.push(manifest.join("resources").join(resource_name));

    candidates.into_iter().find(|path| path.is_file()).ok_or_else(|| {
        format!(
            "bundled pilo-server runtime '{resource_name}' is missing; build or stage that target before packaging Pilo"
        )
    })
}
