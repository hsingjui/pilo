import { LOCAL_HOST_ID } from "@shared/host-id";
import type { NativeHostBackend } from "../client/native-transport";
import type { HostRegistry } from "../hosts/host-registry";
import type { HostSession } from "../hosts/host-session";
import type { DesktopWindowShell } from "./desktop-shell";

type NavigationRequest = {
	id: number;
	projectId: string;
	sessionPath?: string;
	/** Time left to apply it; a later or cancelled request is not applied. */
	expiresInMs: number;
};

const EXPIRED =
	"the request expired or its caller left before the window applied it";

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
	const { nextNavigation, navigationCurrent, completeNavigation } = pilo;
	if (!nextNavigation || !navigationCurrent || !completeNavigation) return;
	for (;;) {
		let request: NavigationRequest | null;
		try {
			request = (await nextNavigation.call(pilo)) as NavigationRequest | null;
		} catch (error) {
			console.warn("desktop navigation stopped:", error);
			return;
		}
		if (!request) return;
		const { id } = request;
		const deadline = Date.now() + request.expiresInMs;
		const current = async () =>
			(await navigationCurrent.call(pilo, id)) && Date.now() < deadline;
		let failure: string | null = null;
		try {
			if (!(await current())) throw new Error(EXPIRED);
			registry.activate(LOCAL_HOST_ID);
			desktop()?.show();
			await local.store.navigateTo(
				request.projectId,
				request.sessionPath,
				current,
			);
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		}
		await completeNavigation.call(pilo, id, failure).catch((error: unknown) => {
			console.warn("could not confirm a desktop navigation:", error);
		});
	}
}
