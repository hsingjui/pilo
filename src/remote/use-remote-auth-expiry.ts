import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { userErrorMessage } from "@/lib/app-error";
import { loadRemoteDeviceAuth, renewRemoteDeviceAuth } from "./remote-client";

/** 设备授权剩余不足该时长时，在每次打开 WebUI 时提示续期。 */
const RENEW_REMINDER_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

type UseRemoteAuthExpiryOptions = {
	token: string | null;
	isNarrow: boolean;
	onError: (error: unknown) => boolean;
};

type AuthExpiryReminder = {
	token: string;
	expiresAtMs: number;
	renew: () => Promise<void>;
	dismiss: () => void;
};

function formatExpiryDate(ms: number, language: string) {
	return new Date(ms).toLocaleString(language, {
		dateStyle: "medium",
		timeStyle: "short",
	});
}

export function useRemoteAuthExpiry({
	token,
	isNarrow,
	onError,
}: UseRemoteAuthExpiryOptions) {
	const { t, i18n } = useTranslation();
	const language = i18n.language;
	const [reminder, setReminder] = useState<AuthExpiryReminder | null>(null);
	const latestRef = useRef({ t, language, onError });
	useEffect(() => {
		latestRef.current = { t, language, onError };
	}, [t, language, onError]);

	// Only check on page load or token change, not on reconnect or resize.
	useEffect(() => {
		if (!token) return;
		let cancelled = false;
		let renewing = false;
		const dismiss = () => {
			if (!cancelled) setReminder(null);
		};
		const renew = async () => {
			if (cancelled || renewing) return;
			renewing = true;
			try {
				const { expiresAtMs } = await renewRemoteDeviceAuth(token);
				if (cancelled) return;
				dismiss();
				const latest = latestRef.current;
				toast.success(latest.t("settings.remoteAuthorizationRenewed"), {
					description: latest.t("settings.remoteAuthorizationExpiresAt", {
						date: formatExpiryDate(expiresAtMs, latest.language),
					}),
				});
			} catch (error) {
				if (cancelled) return;
				const latest = latestRef.current;
				if (latest.onError(error)) return;
				toast.error(latest.t("settings.remoteAuthorizationRenewFailed"), {
					description: userErrorMessage(error),
				});
			} finally {
				renewing = false;
			}
		};
		void loadRemoteDeviceAuth(token)
			.then(({ expiresAtMs }) => {
				if (cancelled) return;
				if (expiresAtMs - Date.now() > RENEW_REMINDER_WINDOW_MS) return;
				setReminder({ token, expiresAtMs, renew, dismiss });
			})
			.catch((error) => {
				// The reminder is optional; only 401 enters the existing auth flow.
				if (!cancelled) latestRef.current.onError(error);
			});
		return () => {
			cancelled = true;
			setReminder((previous) => (previous?.token === token ? null : previous));
		};
	}, [token]);

	const activeReminder = reminder?.token === token ? reminder : null;
	const description = activeReminder
		? t("settings.remoteAuthorizationExpiresAt", {
				date: formatExpiryDate(activeReminder.expiresAtMs, language),
			})
		: "";
	useEffect(() => {
		if (!activeReminder || isNarrow) return;
		const id = toast.warning(t("settings.remoteAuthorizationExpiring"), {
			description,
			duration: Infinity,
			position: "bottom-left",
			onDismiss: activeReminder.dismiss,
			action: {
				label: t("settings.remoteAuthorizationRenew"),
				onClick: (event) => {
					// Sonner otherwise dismisses the reminder before the request settles.
					event.preventDefault();
					void activeReminder.renew();
				},
			},
		});
		return () => {
			toast.dismiss(id);
		};
	}, [activeReminder, description, isNarrow, t]);

	if (!isNarrow || !activeReminder) return null;
	return {
		description,
		renew: activeReminder.renew,
		dismiss: activeReminder.dismiss,
	};
}
