import type {
	DesktopCliApi,
	DesktopCliSkillStatus,
	DesktopCliStatus,
} from "./desktop-shell";

/** The native `DesktopCli` module's calls, keyed by the app's manifest ID. */
export interface DesktopCliNative {
	status(appId: string): Promise<unknown>;
	install(appId: string): Promise<unknown>;
	repair(appId: string): Promise<unknown>;
	uninstall(appId: string): Promise<unknown>;
	syncOnLaunch(appId: string): Promise<unknown>;
	skillStatus(appId: string): Promise<unknown>;
	skillInstall(appId: string): Promise<unknown>;
	skillUpdate(appId: string): Promise<unknown>;
	skillUninstall(appId: string): Promise<unknown>;
}

/**
 * The CLI installer for the app with manifest ID `appId` (`app.hsingjui.pilo`
 * or `app.hsingjui.pilo.dev`, as packaged). Starting it refreshes an
 * installed AppImage's persistent CLI copy; the bundled skill is never
 * installed or updated automatically.
 */
export function createDesktopCli(
	native: DesktopCliNative,
	appId: string,
): DesktopCliApi {
	void native.syncOnLaunch(appId).catch((error: unknown) => {
		console.warn("Failed to sync the installed CLI", error);
	});
	const call = async <T>(action: (appId: string) => Promise<unknown>) =>
		(await action(appId)) as T;
	return {
		status: () => call<DesktopCliStatus>((id) => native.status(id)),
		install: () => call<DesktopCliStatus>((id) => native.install(id)),
		repair: () => call<DesktopCliStatus>((id) => native.repair(id)),
		uninstall: () => call<DesktopCliStatus>((id) => native.uninstall(id)),
		skillStatus: () =>
			call<DesktopCliSkillStatus>((id) => native.skillStatus(id)),
		skillInstall: () =>
			call<DesktopCliSkillStatus>((id) => native.skillInstall(id)),
		skillUpdate: () =>
			call<DesktopCliSkillStatus>((id) => native.skillUpdate(id)),
		skillUninstall: () =>
			call<DesktopCliSkillStatus>((id) => native.skillUninstall(id)),
	};
}
