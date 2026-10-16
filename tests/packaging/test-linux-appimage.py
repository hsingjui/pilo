"""Exercise AppImage finalization without requiring Linux GUI or packaging tools."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/finalize-linux-appimage.sh"
RUNTIMES = (
    "pilo-server-windows-x86_64.exe",
    "pilo-server-linux-x86_64",
    "pilo-server-linux-aarch64",
    "pilo-server-darwin-aarch64",
)
SERVER = b"""#!/usr/bin/env python3
import hashlib
from pathlib import Path
print(hashlib.sha256(Path(__file__).read_bytes()).hexdigest()[:16])
"""
# The fake output plugin snapshots the AppDir into a self-extracting fixture.
# Mutations here model a packer reintroducing libraries or corrupting resources.
PACKER = """#!/usr/bin/env python3
import base64
import io
import os
from pathlib import Path
import sys
import tarfile
appdir = Path(sys.argv[2])
mode = os.environ.get('PILO_TEST_PACKER_MODE', '')
if mode == 'corrupt':
    (appdir / 'usr/lib/Pilo/runtime/pilo-server-linux-aarch64').write_bytes(b'corrupted')
if mode == 'wayland':
    (appdir / 'usr/lib/libwayland-client.so.0').write_bytes(b'old-library')
if mode == 'force-x11':
    hook = appdir / 'apprun-hooks/linuxdeploy-plugin-gtk.sh'
    hook.write_text(hook.read_text() + 'export GDK_BACKEND=x11\\n')
payload = io.BytesIO()
with tarfile.open(fileobj=payload, mode='w:gz') as archive:
    archive.add(appdir, arcname='squashfs-root')
extractor = '''#!/usr/bin/env python3
import base64
import io
import tarfile
with tarfile.open(fileobj=io.BytesIO(base64.b64decode(PAYLOAD)), mode='r:gz') as archive:
    archive.extractall('.')
'''.replace('PAYLOAD', repr(base64.b64encode(payload.getvalue()).decode()))
Path(os.environ['OUTPUT']).write_text(extractor)
"""


class AppImageFinalizationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pilo-appimage-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.appdir = self.root / "Pilo.AppDir"
        self.bundled = self.appdir / "usr/lib/Pilo/runtime"
        self.bundled.mkdir(parents=True)
        self.originals = self.root / "original runtimes"
        self.originals.mkdir()
        for name in RUNTIMES:
            source = self.originals / name
            source.write_bytes(SERVER if name.endswith("linux-x86_64") else name.encode())
            source.chmod(0o755)
            (self.bundled / name).write_bytes(b"linuxdeploy modified binary")
        (self.appdir / "AppRun").write_text("#!/bin/sh\nexit 0\n")
        (self.appdir / "AppRun").chmod(0o755)
        self.hooks = self.appdir / "apprun-hooks"
        self.hooks.mkdir()
        self.gtk_hook = self.hooks / "linuxdeploy-plugin-gtk.sh"
        self.gtk_hook.write_text(
            "#!/bin/sh\n"
            "export GDK_BACKEND=x11 # linuxdeploy compatibility workaround\n"
            "export GTK_THEME=Adwaita\n"
        )
        self.library = self.appdir / "usr/lib/libwayland-client.so.0"
        self.library.write_bytes(b"old-wayland")
        self.library.with_name("libwayland-client.so").symlink_to(self.library.name)
        (self.appdir / "usr/lib/libwayland-cursor.so.0").write_bytes(b"keep")
        self.image = self.root / "Pilo test.AppImage"
        self.image.write_bytes(b"old-appimage")
        self.plugin = self.root / "output plugin"
        self.plugin.write_text(PACKER)
        self.plugin.chmod(0o755)

    def run_finalizer(self, mode=""):
        return subprocess.run(
            ["bash", str(SCRIPT), str(self.image), str(self.appdir),
             str(self.originals), str(self.plugin)],
            env=dict(os.environ, PILO_TEST_PACKER_MODE=mode),
            capture_output=True, text=True, timeout=20,
        )

    def test_restores_runtimes_and_excludes_only_wayland_client(self):
        result = self.run_finalizer()
        self.assertEqual(result.returncode, 0, result.stderr)
        verify = self.root / "verify"
        verify.mkdir()
        subprocess.run([str(self.image), "--appimage-extract"], cwd=verify, check=True)
        extracted_root = verify / "squashfs-root"
        extracted = extracted_root / "usr/lib"
        self.assertEqual(list(extracted.glob("libwayland-client.so*")), [])
        self.assertTrue((extracted / "libwayland-cursor.so.0").is_file())
        gtk_hook = extracted_root / "apprun-hooks/linuxdeploy-plugin-gtk.sh"
        self.assertNotIn("GDK_BACKEND=x11", gtk_hook.read_text())
        self.assertIn("GTK_THEME=Adwaita", gtk_hook.read_text())
        for name in RUNTIMES:
            self.assertEqual((extracted / "Pilo/runtime" / name).read_bytes(),
                             (self.originals / name).read_bytes())

    def test_rejects_corrupted_final_runtime(self):
        self.assertNotEqual(self.run_finalizer("corrupt").returncode, 0)
        self.assertEqual(self.image.read_bytes(), b"old-appimage")

    def test_rejects_reintroduced_wayland_library(self):
        self.assertNotEqual(self.run_finalizer("wayland").returncode, 0)
        self.assertEqual(self.image.read_bytes(), b"old-appimage")

    def test_rejects_reintroduced_forced_x11_backend(self):
        result = self.run_finalizer("force-x11")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("still forces the GTK X11 backend", result.stderr)
        self.assertEqual(self.image.read_bytes(), b"old-appimage")

    def test_rejects_missing_original_runtime(self):
        (self.originals / RUNTIMES[0]).unlink()
        self.assertNotEqual(self.run_finalizer().returncode, 0)
        self.assertEqual(self.image.read_bytes(), b"old-appimage")

    def test_rejects_server_that_cannot_start(self):
        (self.originals / "pilo-server-linux-x86_64").write_text("#!/bin/sh\nexit 139\n")
        self.assertNotEqual(self.run_finalizer().returncode, 0)
        self.assertEqual(self.image.read_bytes(), b"old-appimage")


if __name__ == "__main__":
    unittest.main()
