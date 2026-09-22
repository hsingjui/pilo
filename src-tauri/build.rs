use std::path::Path;

const SERVER_RESOURCES: &[&str] = &[
    "pilo-server-windows-x86_64.exe",
    "pilo-server-linux-x86_64",
    "pilo-server-linux-aarch64",
    "pilo-server-darwin-aarch64",
];

fn main() {
    // 只对存在文件发 rerun-if-changed：cargo 把不存在的路径当作“永远变更”，
    // 会让本 build script（以及 pilo crate）每次构建都重跑。
    // 监听 resources 目录本身，这样后续新增运行时也能被感知。
    println!("cargo:rerun-if-changed=resources");
    for resource in SERVER_RESOURCES {
        if Path::new("resources").join(resource).is_file() {
            println!("cargo:rerun-if-changed=resources/{resource}");
        }
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
