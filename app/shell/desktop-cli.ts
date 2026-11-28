import type { DesktopCliApi, DesktopCliStatus } from "./desktop-shell";

/** The native `DesktopCli` module's calls, keyed by the app's manifest ID. */
export interface DesktopCliNative {
	status(appId: string): Promise<unknown>;
	install(appId: string): Promise<unknown>;
	repair(appId: string): Promise<unknown>;
	uninstall(appId: string): Promise<unknown>;
	syncOnLaunch(appId: string): Promise<unknown>;
}

/**
 * The CLI installer for the app with manifest ID `appId` (`app.hsingjui.pilo`
 * or `app.hsingjui.pilo.dev`, as packaged). Starting it refreshes an
 * installed AppImage's persistent CLI copy.
 */
export function createDesktopCli(
	native: DesktopCliNative,
	appId: string,
): DesktopCliApi {
	void native.syncOnLaunch(appId).catch((error: unknown) => {
		console.warn("Failed to sync the installed CLI", error);
	});
	const call = async (action: (appId: string) => Promise<unknown>) =>
		(await action(appId)) as DesktopCliStatus;
	return {
		status: () => call((id) => native.status(id)),
		install: () => call((id) => native.install(id)),
		repair: () => call((id) => native.repair(id)),
		uninstall: () => call((id) => native.uninstall(id)),
	};
}
