use std::path::Path;

const SERVER_RESOURCES: &[&str] = &[
    "pilo-server-windows-x86_64.exe",
    "pilo-server-windows-aarch64.exe",
    "pilo-server-linux-x86_64",
    "pilo-server-linux-aarch64",
    "pilo-server-darwin-x86_64",
    "pilo-server-darwin-aarch64",
];

fn main() {
    for resource in SERVER_RESOURCES {
        println!("cargo:rerun-if-changed=resources/{resource}");
    }
    println!("cargo:rerun-if-env-changed=PILO_ALLOW_INCOMPLETE_SERVER_BUNDLE");

    if std::env::var("PROFILE").as_deref() == Ok("release")
        && std::env::var_os("PILO_ALLOW_INCOMPLETE_SERVER_BUNDLE").is_none()
    {
        let missing = SERVER_RESOURCES
            .iter()
            .filter(|resource| !Path::new("resources").join(resource).is_file())
            .copied()
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            panic!(
                "release bundle is missing pilo-server runtimes: {}. Stage all supported targets before packaging, or set PILO_ALLOW_INCOMPLETE_SERVER_BUNDLE=1 for a non-distributable diagnostic build",
                missing.join(", ")
            );
        }
    }

    tauri_build::build()
}
