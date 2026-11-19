import { useCallback, useEffect } from "react";
import { toast } from "sonner";

import { i18n } from "@/i18n";
import type { PiloClient } from "@/lib/api/pilo-client";
import type { PiloRuntimeEvent } from "@/lib/api/pi-runtime";
import { useTheme } from "@/lib/theme-provider";

export function useRemoteTheme({
	client,
	refreshKey,
	onError,
}: {
	client: PiloClient | null;
	refreshKey: string;
	onError: (error: unknown) => boolean;
}) {
	const { applyThemeSettings, bindThemeWriter } = useTheme();

	useEffect(() => {
		if (!client) return;
		return bindThemeWriter(async (update) => {
			try {
				return await client.saveThemeSettings(update);
			} catch (error) {
				onError(error);
				throw error;
			}
		});
	}, [client, bindThemeWriter, onError]);

	/* oxlint-disable react/exhaustive-effect-dependencies -- Snapshot/replay generations intentionally reload the authoritative Host theme. */
	useEffect(() => {
		void refreshKey;
		if (!client) return;
		let disposed = false;
		const refresh = async () => {
			try {
				const settings = await client.loadThemeSettings();
				if (!disposed) applyThemeSettings(settings);
			} catch (error) {
				if (!disposed && !onError(error))
					toast.error(i18n.t("settings.themeLoadFailed"), {
						description: String(error),
					});
			}
		};
		const onVisible = () => {
			if (document.visibilityState === "visible") void refresh();
		};
		void refresh();
		window.addEventListener("pageshow", onVisible);
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			disposed = true;
			window.removeEventListener("pageshow", onVisible);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [client, refreshKey, onError, applyThemeSettings]);

	/* oxlint-enable react/exhaustive-effect-dependencies */

	const handleThemeEvent = useCallback(
		(event: PiloRuntimeEvent) => {
			if (event.type === "theme_settings_changed")
				applyThemeSettings(event.settings);
		},
		[applyThemeSettings],
	);

	return { handleThemeEvent };
}
