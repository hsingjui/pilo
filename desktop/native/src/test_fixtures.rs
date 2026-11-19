use std::{
    fs::{self, DirBuilder},
    io::ErrorKind,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

use nsh_core::prelude::*;

pub(crate) fn register(registry: &mut Registry) {
    registry.module::<ImageFixture>();
    registry.class::<BootstrapFixture>();
}

/// Native image sources for the desktop transport tests.
#[module]
struct ImageFixture;

#[module]
impl ImageFixture {
    /// The fixture PNG as native bytes.
    pub fn bytes() -> Vec<u8> {
        include_bytes!("../../../src-tauri/icons/32x32.png").to_vec()
    }

    /// The fixture PNG as an absolute local path.
    pub fn path() -> String {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../src-tauri/icons/32x32.png")
            .to_string_lossy()
            .into_owned()
    }
}

/// An isolated data directory owned by the native bootstrap fixture.
#[class]
struct BootstrapFixture(PathBuf);

#[class]
impl BootstrapFixture {
    /// Creates fixture storage without touching the installed application's data.
    pub fn new() -> Result<Self, String> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir();
        let mut builder = DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        loop {
            let sequence = NEXT.fetch_add(1, Ordering::Relaxed);
            let path = root.join(format!("pilo-nsh-test-{}-{sequence}", std::process::id()));
            match builder.create(&path) {
                Ok(()) => return Ok(Self(path)),
                Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.to_string()),
            }
        }
    }

    /// Returns the fixture directory.
    pub fn data_dir(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for BootstrapFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
