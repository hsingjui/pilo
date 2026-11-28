import { mount, Scroll, View } from "nsh";

import { CliPane } from "../settings/cli-pane";
import type { DesktopCliApi, DesktopCliStatus } from "../shell/desktop-shell";
import { initializeI18n } from "../shell/i18n";

const base: DesktopCliStatus = {
	command: "pilo",
	state: "not_installed",
	reason: null,
	bundledPath: "/Applications/Pilo.app/Contents/Resources/bin/pilo",
	// The bundled CLI's `version` failed: the page shows the version as unknown.
	bundledVersion: null,
	entryPath: null,
	entryTarget: null,
	installedVersion: null,
	pathDir: null,
	shadowedBy: null,
	conflictPath: null,
	installation: { source: "installed", path: "/Applications/Pilo.app" },
	outcome: null,
};

let current = base;

const installed: DesktopCliStatus = {
	...base,
	state: "ready",
	entryPath: "/Users/me/.local/bin/pilo",
	entryTarget: base.bundledPath,
	installedVersion: "0.5.2",
	pathDir: "/Users/me/.local/bin",
	shadowedBy: "/opt/homebrew/bin/pilo",
	outcome: "fallback",
};

const cli: DesktopCliApi = {
	status: () => Promise.resolve({ ...current, outcome: null }),
	install: () => Promise.resolve((current = installed)),
	repair: () => Promise.resolve((current = installed)),
	uninstall: () =>
		Promise.resolve((current = { ...base, outcome: "uninstalled" })),
};

initializeI18n();
mount(() => (
	<Scroll class="flex-1 bg-background">
		<View class="p-3">
			<CliPane cli={cli} />
		</View>
	</Scroll>
));
