import { LOCAL_HOST_ID } from "@shared/host-id";
import type { NativeHostBackend } from "../client/native-transport";
import type { HostRegistry } from "../hosts/host-registry";
import type { HostSession } from "../hosts/host-session";
import type { DesktopWindowShell } from "./desktop-shell";

type NavigationRequest = {
	id: number;
	projectId: string;
	sessionPath?: string;
};

/**
 * Applies the navigations local clients (`pilo open`) ask the embedded Host
 * for: the window shows this machine's Host, then the project or session.
 * Every request gets a receipt, so the CLI only reports what happened.
 */
export async function serveDesktopNavigation(
	pilo: NativeHostBackend,
	{
		local,
		registry,
		desktop,
	}: {
		local: HostSession;
		registry: HostRegistry;
		desktop: () => DesktopWindowShell | undefined;
	},
) {
	const { nextNavigation, completeNavigation } = pilo;
	if (!nextNavigation || !completeNavigation) return;
	for (;;) {
		let request: NavigationRequest | null;
		try {
			request = (await nextNavigation.call(pilo)) as NavigationRequest | null;
		} catch (error) {
			console.warn("desktop navigation stopped:", error);
			return;
		}
		if (!request) return;
		let failure: string | null = null;
		try {
			registry.activate(LOCAL_HOST_ID);
			desktop()?.show();
			await local.store.navigateTo(request.projectId, request.sessionPath);
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		}
		await completeNavigation
			.call(pilo, request.id, failure)
			.catch((error: unknown) => {
				console.warn("could not confirm a desktop navigation:", error);
			});
	}
}
