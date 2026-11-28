import { DesktopDock, DesktopNotifications, Pilo } from "app/native";
import process from "process";

import { desktopRemoteProxy } from "./app/hosts/remote-proxy";
import { createDesktopNotifications } from "./app/shell/desktop-notifications";
import { initializeI18n } from "./app/shell/i18n";
import { launch } from "./app/shell/launch";
import { createNativeDesktopShell } from "./app/shell/native-desktop-shell";
import manifest from "./nsh.json";

initializeI18n();
const pilo = new Pilo(null, process.logFile);
// The packaged id is the App ID the bundled CLI connects to by default.
pilo.startLocalIpc(manifest.id).catch((error: unknown) => {
	console.warn("local IPC is unavailable:", error);
});
void launch(
	pilo,
	createNativeDesktopShell(pilo, {
		settings: pilo,
		notifications: createDesktopNotifications(DesktopNotifications),
		dock: DesktopDock,
	}),
	{
		credentials: pilo,
		proxy: desktopRemoteProxy,
		machineName: () => pilo.machineName(),
		badge: DesktopDock,
	},
);
