import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
	isPermissionGranted,
	onAction,
	registerActionTypes,
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

const AGENT_RESULT_ACTION_TYPE = "pilo-agent-result";
const OPEN_SESSION_ACTION = "open-session";
const SESSION_TARGET_KIND = "session";
const MACOS_DEFAULT_NOTIFICATION_SOUND = "NSUserNotificationDefaultSoundName";
const NOTIFICATION_OPEN_SESSION_EVENT = "pilo://notification-open-session";

function isMacOS() {
	return (
		typeof navigator !== "undefined" && navigator.userAgent.includes("Mac")
	);
}

function defaultNotificationSound(): Pick<NotificationOptions, "sound"> {
	if (isMacOS()) {
		return { sound: MACOS_DEFAULT_NOTIFICATION_SOUND };
	}
	return {};
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

export async function getDesktopNotificationPermission(): Promise<DesktopNotificationPermission> {
	if (!isTauri()) return "unsupported";

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
	const permission = await getDesktopNotificationPermission();
	if (permission === "granted") return true;
	if (permission === "unsupported") return false;

	try {
		return (await requestPermission()) === "granted";
	} catch {
		return false;
	}
}

function notificationTarget(
	notification: NotificationOptions,
): DesktopNotificationSessionTarget | null {
	const extra = notification.extra;
	if (!extra || extra.piloTarget !== SESSION_TARGET_KIND) return null;
	const projectId = extra.projectId;
	const sessionId = extra.sessionId;
	if (typeof projectId !== "string" || typeof sessionId !== "string")
		return null;
	if (!projectId || !sessionId) return null;
	return { projectId, sessionId };
}

async function focusPiloWindow() {
	const window = getCurrentWindow();
	await window.unminimize().catch(() => undefined);
	await window.show().catch(() => undefined);
	await window.setFocus().catch(() => undefined);
}

export async function listenForDesktopNotificationActions(
	onOpenSession: (target: DesktopNotificationSessionTarget) => void,
): Promise<() => void> {
	if (!isTauri()) return () => undefined;
	if (isMacOS()) {
		const unlisten = await listen<DesktopNotificationSessionTarget>(
			NOTIFICATION_OPEN_SESSION_EVENT,
			(event) => onOpenSession(event.payload),
		);
		return unlisten;
	}

	try {
		await registerActionTypes([
			{
				id: AGENT_RESULT_ACTION_TYPE,
				actions: [
					{
						id: OPEN_SESSION_ACTION,
						title: "打开会话",
						foreground: true,
					},
				],
			},
		]);
	} catch (error) {
		console.warn("Failed to register notification actions", error);
	}

	const listener = await onAction((notification) => {
		const target = notificationTarget(notification);
		if (!target) return;
		void focusPiloWindow();
		onOpenSession(target);
	});

	return () => {
		void listener.unregister();
	};
}

export async function sendDesktopNotificationTest(): Promise<boolean> {
	if (!(await ensureDesktopNotificationPermission())) return false;

	try {
		if (isMacOS()) {
			await sendMacOSNotification({
				title: "Pilo 测试通知",
				body: "通知工作正常。Agent 完成或出错时会在这里提醒你。",
			});
			return true;
		}
		sendNotification({
			title: "Pilo 测试通知",
			body: "通知工作正常。Agent 完成或出错时会在这里提醒你。",
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

	const title = status === "completed" ? "Agent 运行完成" : "Agent 运行出错";
	const fallbackSessionTitle = sessionTitle.trim() || "当前会话";
	const body =
		status === "completed"
			? `${fallbackSessionTitle} 已完成运行。`
			: errorMessage?.trim()
				? `${fallbackSessionTitle}：${errorMessage.trim()}`
				: `${fallbackSessionTitle} 运行出错。`;

	try {
		if (isMacOS()) {
			await sendMacOSNotification({
				title,
				body,
				target: { projectId, sessionId },
			});
			return true;
		}
		sendNotification({
			title,
			body,
			actionTypeId: AGENT_RESULT_ACTION_TYPE,
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
