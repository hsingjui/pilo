import type { Pilo } from "app/native";
import { openUrl } from "nsh";
import process from "process";

import type { SystemFontFamily } from "@shared/font-settings";
import type { WorkspaceFile } from "@shared/project-workspace";
import { defaultDesktopNotifications } from "./desktop-notifications";
import type { DesktopShell } from "./desktop-shell";
import { createDesktopUpdate } from "./desktop-update";

type ShellNative = Pick<
	Pilo,
	"pickLocalProjectDirectory" | "openLogDirectory"
> &
	Partial<
		Pick<
			Pilo,
			| "saveImage"
			| "readLocalFile"
			| "systemFontFamilies"
			| "projectOpenInApp"
			| "openFileLink"
		>
	>;

type NativeDesktopShell = Required<Omit<DesktopShell, "dock" | "settings">> &
	Pick<DesktopShell, "dock" | "settings">;

function unavailable(name: string) {
	return new Error(`The native call ${name} is unavailable`);
}

export function createNativeDesktopShell(
	pilo: ShellNative,
	options: Pick<DesktopShell, "notifications" | "dock" | "settings"> = {},
): NativeDesktopShell {
	return {
		openExternal: openUrl,
		pickLocalProjectDirectory: () => pilo.pickLocalProjectDirectory(),
		async saveImage(suggestedName, bytes) {
			if (!pilo.saveImage) throw unavailable("saveImage");
			return await pilo.saveImage(suggestedName, bytes);
		},
		async readLocalFile(uri) {
			if (!pilo.readLocalFile) throw unavailable("readLocalFile");
			return (await pilo.readLocalFile(uri)) as Uint8Array<ArrayBuffer>;
		},
		async systemFontFamilies() {
			const families = await pilo.systemFontFamilies?.();
			return (families ?? []) as SystemFontFamily[];
		},
		openLogDirectory: () => pilo.openLogDirectory(process.logFile),
		async openProjectInApp(projectId, app, path) {
			if (!pilo.projectOpenInApp) throw unavailable("projectOpenInApp");
			await pilo.projectOpenInApp(projectId, app, path);
		},
		async openFileLink(projectId, url, preview) {
			if (!pilo.openFileLink) throw unavailable("openFileLink");
			return (await pilo.openFileLink(
				projectId,
				url,
				preview,
			)) as WorkspaceFile | null;
		},
		createUpdate: createDesktopUpdate,
		notifications: options.notifications ?? defaultDesktopNotifications(),
		dock: options.dock,
		settings: options.settings,
	};
}
