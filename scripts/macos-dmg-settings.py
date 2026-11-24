# dmgbuild provides `defines` from the command line.
files = [defines["app"]]
symlinks = {"Applications": "/Applications"}
format = "UDZO"
filesystem = "APFS"

# Keep the window and icon positions aligned with dmgbuild's built-in arrow.
background = "builtin-arrow"
window_rect = ((100, 100), (640, 280))
icon_size = 96
icon_locations = {"Pilo.app": (140, 120), "Applications": (500, 120)}
