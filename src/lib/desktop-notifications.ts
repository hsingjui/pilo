import { invoke, isTauri } from "@tauri-apps/api/core";

import { i18n } from "../i18n/index.ts";
import { listen } from "@tauri-apps/api/event";
import {
	isPermissionGranted,
	requestPermission,
	sendNotification,
	type Options as NotificationOptions,
} from "@tauri-apps/plugin-notification";

export type DesktopNotificationPermission =
	| "granted"
	| "denied"
	| "default"
	| "unsupported";

export type DesktopNotificationSessionTarget = {
	projectId: string;
	sessionId: string;
};

export type AgentNotificationStatus = "completed" | "error";

const SESSION_TARGET_KIND = "session";
const MACOS_DEFAULT_NOTIFICATION_SOUND = "NSUserNotificationDefaultSoundName";
const NOTIFICATION_OPEN_SESSION_EVENT = "pilo://notification-open-session";
const NOTIFICATION_TITLE_MAX_LENGTH = 72;
const NOTIFICATION_BODY_MAX_LENGTH = 220;

function isMacOS() {
	return (
		typeof navigator !== "undefined" && navigator.userAgent.includes("Mac")
	);
}

function isWindows() {
	return (
		typeof navigator !== "undefined" && navigator.userAgent.includes("Windows")
	);
}

function defaultNotificationSound(): Pick<NotificationOptions, "sound"> {
	if (isMacOS()) {
		return { sound: MACOS_DEFAULT_NOTIFICATION_SOUND };
	}
	return {};
}

function compactNotificationText(text: string, maxLength: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	const characters = Array.from(normalized);
	if (characters.length <= maxLength) return normalized;
	return `${characters.slice(0, Math.max(0, maxLength - 1)).join("")}…`;
}

function agentNotificationContent({
	status,
	sessionTitle,
	errorMessage,
}: {
	status: AgentNotificationStatus;
	sessionTitle: string;
	errorMessage?: string;
}) {
	const statusLabel = i18n.t(
		status === "completed" ? "notifications.completed" : "notifications.error",
	);
	const fallbackTitle = i18n.t(
		status === "completed"
			? "notifications.agentCompleted"
			: "notifications.agentFailed",
	);
	const normalizedSessionTitle = compactNotificationText(sessionTitle, 120);
	const suffix = ` · ${statusLabel}`;
	const availableSessionLength =
		NOTIFICATION_TITLE_MAX_LENGTH - Array.from(suffix).length;
	const title = normalizedSessionTitle
		? `${compactNotificationText(normalizedSessionTitle, availableSessionLength)}${suffix}`
		: fallbackTitle;

	if (status === "completed") {
		return {
			title,
			body: i18n.t("notifications.completedBody"),
		};
	}

	const normalizedError = errorMessage
		? compactNotificationText(errorMessage, NOTIFICATION_BODY_MAX_LENGTH - 10)
		: "";
	return {
		title,
		body: normalizedError
			? compactNotificationText(
					i18n.t("notifications.errorDetail", { message: normalizedError }),
					NOTIFICATION_BODY_MAX_LENGTH,
				)
			: i18n.t("notifications.errorBody"),
	};
}

async function sendMacOSNotification({
	title,
	body,
	target,
}: {
	title: string;
	body: string;
	target?: DesktopNotificationSessionTarget;
}) {
	await invoke("send_macos_desktop_notification", {
		request: {
			title,
			body,
			target: target ?? null,
		},
	});
}

async function sendWindowsNotification({
	title,
	body,
	target,
}: {
	title: string;
	body: string;
	target?: DesktopNotificationSessionTarget;
}) {
	await invoke("send_windows_desktop_notification", {
		request: {
			title,
			body,
			target: target ?? null,
		},
	});
}

export function isDesktopNotificationPermissionSystemManaged(): boolean {
	return isTauri() && isWindows();
}

export async function getDesktopNotificationPermission(): Promise<DesktopNotificationPermission> {
	if (!isTauri()) return "unsupported";
	if (isWindows()) return "granted";

	try {
		if (await isPermissionGranted()) return "granted";
		if (
			typeof Notification !== "undefined" &&
			Notification.permission === "denied"
		) {
			return "denied";
		}
		return "default";
	} catch {
		return "unsupported";
	}
}

export async function ensureDesktopNotificationPermission(): Promise<boolean> {
	if (isWindows()) return true;
	const permission = await getDesktopNotificationPermission();
	if (permission === "granted") return true;
	if (permission === "unsupported") return false;

	try {
		return (await requestPermission()) === "granted";
	} catch {
		return false;
	}
}

export async function listenForDesktopNotificationActions(
	onOpenSession: (target: DesktopNotificationSessionTarget) => void,
): Promise<() => void> {
	if (!isTauri()) return () => undefined;
	if (isMacOS() || isWindows()) {
		return listen<DesktopNotificationSessionTarget>(
			NOTIFICATION_OPEN_SESSION_EVENT,
			(event) => onOpenSession(event.payload),
		);
	}
	return () => undefined;
}

export async function sendDesktopNotificationTest(): Promise<boolean> {
	if (!(await ensureDesktopNotificationPermission())) return false;

	try {
		if (isMacOS()) {
			await sendMacOSNotification({
				title: i18n.t("notifications.testTitle"),
				body: i18n.t("notifications.testBody"),
			});
			return true;
		}
		if (isWindows()) {
			await sendWindowsNotification({
				title: i18n.t("notifications.testTitle"),
				body: i18n.t("notifications.testBody"),
			});
			return true;
		}
		sendNotification({
			title: i18n.t("notifications.testTitle"),
			body: i18n.t("notifications.testBody"),
			autoCancel: true,
			...defaultNotificationSound(),
		});
		return true;
	} catch {
		return false;
	}
}

export async function notifyAgentResult({
	status,
	projectId,
	sessionId,
	sessionTitle,
	errorMessage,
}: {
	status: AgentNotificationStatus;
	projectId: string;
	sessionId: string;
	sessionTitle: string;
	errorMessage?: string;
}): Promise<boolean> {
	if ((await getDesktopNotificationPermission()) !== "granted") return false;

	const { title, body } = agentNotificationContent({
		status,
		sessionTitle,
		errorMessage,
	});

	try {
		if (isMacOS()) {
			await sendMacOSNotification({
				title,
				body,
				target: { projectId, sessionId },
			});
			return true;
		}
		if (isWindows()) {
			await sendWindowsNotification({
				title,
				body,
				target: { projectId, sessionId },
			});
			return true;
		}
		sendNotification({
			title,
			body,
			autoCancel: true,
			...defaultNotificationSound(),
			extra: {
				piloTarget: SESSION_TARGET_KIND,
				projectId,
				sessionId,
			},
		});
		return true;
	} catch {
		return false;
	}
}
