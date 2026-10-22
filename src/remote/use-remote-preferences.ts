import { useCallback, useEffect } from "react";
import { toast } from "sonner";
import { i18n } from "@/i18n";
import type { PiloClient } from "@/lib/api/pilo-client";
import type { PiloRuntimeEvent } from "@/lib/api/pi-runtime";
import {
	bindHostPreferences,
	publishHostPreferences,
	refreshHostPreferences,
} from "@/lib/host-preferences";

export function useRemotePreferences({
	client,
	refreshKey,
	onError,
}: {
	client: PiloClient | null;
	refreshKey: string;
	onError: (error: unknown) => boolean;
}) {
	useEffect(() => {
		if (!client) return;
		const connection = bindHostPreferences({
			load: () => client.loadPreferences(),
			patch: (patch) => client.savePreferences(patch),
		});
		let disposed = false;
		void connection.ready.catch((error: unknown) => {
			if (!disposed && !onError(error))
				toast.error(i18n.t("settings.preferencesLoadFailed"), {
					description: String(error),
				});
		});
		return () => {
			disposed = true;
			connection.dispose();
		};
	}, [client, onError]);

	/* oxlint-disable react/exhaustive-effect-dependencies -- Snapshot/replay generations intentionally reload authoritative Host preferences. */
	useEffect(() => {
		void refreshKey;
		if (!client) return;
		const refresh = () => {
			if (document.visibilityState === "visible")
				void refreshHostPreferences().catch((error: unknown) => {
					if (!onError(error))
						console.warn("Failed to refresh Host preferences", error);
				});
		};
		refresh();
		document.addEventListener("visibilitychange", refresh);
		window.addEventListener("pageshow", refresh);
		return () => {
			document.removeEventListener("visibilitychange", refresh);
			window.removeEventListener("pageshow", refresh);
		};
	}, [client, refreshKey, onError]);
	/* oxlint-enable react/exhaustive-effect-dependencies */

	return useCallback((event: PiloRuntimeEvent) => {
		if (event.type === "preferences_changed")
			publishHostPreferences(event.settings);
	}, []);
}
