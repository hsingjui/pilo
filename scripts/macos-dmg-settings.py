import inspect
from pathlib import Path

# dmgbuild executes this file via exec() without __file__ and provides `defines`.
_ROOT = Path(inspect.currentframe().f_code.co_filename).resolve().parent.parent

files = [defines["app"]]
symlinks = {"Applications": "/Applications"}
format = "UDZO"
filesystem = "APFS"

# dmgbuild automatically pairs dmg-background.png with dmg-background@2x.png into a HiDPI TIFF.
background = str(_ROOT / "assets/branding/dmg-background.png")
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False

# Background artwork is 640x320; add ~28pt for the macOS Finder title bar.
window_rect = ((100, 100), (640, 348))
icon_size = 104
text_size = 13
icon_locations = {"Pilo.app": (160, 150), "Applications": (480, 150)}
