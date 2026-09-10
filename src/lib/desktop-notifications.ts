import { isTauri } from "@tauri-apps/api/core";
import {
	isPermissionGranted,
	requestPermission,
	sendNotification,
} from "@tauri-apps/plugin-notification";

export async function ensureDesktopNotificationPermission(): Promise<boolean> {
	if (!isTauri()) return false;
	if (await isPermissionGranted()) return true;
	return (await requestPermission()) === "granted";
}

export function notifyReplyCompleted(sessionTitle: string) {
	if (!isTauri()) return;
	if (typeof document !== "undefined" && document.hasFocus()) return;

	sendNotification({
		title: "Pilo",
		body: `${sessionTitle || "当前会话"} 已完成回复`,
	});
}
