import { openUrl } from "nsh";

import type { DesktopShell } from "../app/shell/desktop-shell";

export const webDesktopShell: DesktopShell = {
	openExternal: openUrl,
	// Image saving is not wired in WebUI until P4.
};
