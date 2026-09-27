import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type { PiExtensionNotification } from "@/components/chat/pi-extension-notifications";
import type { PiExtensionDialogRequest } from "@/components/chat/use-pi-session-features";
import { runtimeErrorMessage } from "@/lib/pi-runtime";
import type { RemoteRpc } from "./use-remote-chat-transport";

const MAX_EXTENSION_NOTIFICATIONS = 3;
const INFO_NOTIFICATION_DURATION_MS = 5_000;
const WARNING_NOTIFICATION_DURATION_MS = 10_000;
const EXTENSION_NOTIFICATION_DEDUP_WINDOW_MS = 10_000;

function extensionNotificationDedupKey(
	notification: PiExtensionNotification,
): string {
	return `${notification.type}:${notification.message}`;
}

export function useRemoteExtensionUi({
	rpc,
	activeSessionKey,
	onSetEditorText,
}: {
	rpc: RemoteRpc;
	activeSessionKey: string | null;
	onSetEditorText: (text: string) => void;
}) {
	const { t } = useTranslation();
	// `rpc` is bound to the active session, so each queued dialog carries the
	// session it belongs to; only the active session's dialog is shown/answered.
	const [extensionDialogQueue, setExtensionDialogQueue] = useState<
		{ sessionKey: string | null; request: PiExtensionDialogRequest }[]
	>([]);
	const [extensionNotifications, setExtensionNotifications] = useState<
		PiExtensionNotification[]
	>([]);
	const extensionNotificationTimersRef = useRef(new Map<string, number>());
	const extensionNotificationLastSeenRef = useRef(new Map<string, number>());

	const dismissExtensionNotification = useCallback((id: string) => {
		const timer = extensionNotificationTimersRef.current.get(id);
		if (timer !== undefined) {
			window.clearTimeout(timer);
			extensionNotificationTimersRef.current.delete(id);
		}
		setExtensionNotifications((current) =>
			current.filter((notification) => notification.id !== id),
		);
	}, []);

	const showExtensionNotification = useCallback(
		(event: PiExtensionDialogRequest) => {
			const notification: PiExtensionNotification = {
				id: event.id,
				message: event.message || event.title || "Pi extension notification",
				type: event.notifyType ?? "info",
			};
			const dedupKey = extensionNotificationDedupKey(notification);
			const now = Date.now();
			for (const [key, seenAt] of extensionNotificationLastSeenRef.current) {
				if (now - seenAt >= EXTENSION_NOTIFICATION_DEDUP_WINDOW_MS) {
					extensionNotificationLastSeenRef.current.delete(key);
				}
			}
			const lastSeenAt = extensionNotificationLastSeenRef.current.get(dedupKey);
			extensionNotificationLastSeenRef.current.set(dedupKey, now);
			if (
				lastSeenAt !== undefined &&
				now - lastSeenAt < EXTENSION_NOTIFICATION_DEDUP_WINDOW_MS
			) {
				return;
			}
			setExtensionNotifications((current) => {
				if (
					current.some(
						(item) => extensionNotificationDedupKey(item) === dedupKey,
					)
				) {
					return current;
				}
				return [
					...current.filter((item) => item.id !== notification.id),
					notification,
				].slice(-MAX_EXTENSION_NOTIFICATIONS);
			});
		},
		[],
	);

	useEffect(() => {
		const visible = new Map(
			extensionNotifications.map((notification) => [
				notification.id,
				notification,
			]),
		);
		for (const [id, timer] of extensionNotificationTimersRef.current) {
			const notification = visible.get(id);
			if (!notification || notification.type === "error") {
				window.clearTimeout(timer);
				extensionNotificationTimersRef.current.delete(id);
			}
		}
		for (const notification of extensionNotifications) {
			if (
				notification.type === "error" ||
				extensionNotificationTimersRef.current.has(notification.id)
			) {
				continue;
			}
			const duration =
				notification.type === "warning"
					? WARNING_NOTIFICATION_DURATION_MS
					: INFO_NOTIFICATION_DURATION_MS;
			const timer = window.setTimeout(
				() => dismissExtensionNotification(notification.id),
				duration,
			);
			extensionNotificationTimersRef.current.set(notification.id, timer);
		}
	}, [dismissExtensionNotification, extensionNotifications]);

	useEffect(
		() => () => {
			for (const timer of extensionNotificationTimersRef.current.values()) {
				window.clearTimeout(timer);
			}
			extensionNotificationTimersRef.current.clear();
		},
		[],
	);

	const handleExtensionRequest = useCallback(
		(event: PiExtensionDialogRequest) => {
			switch (event.method) {
				case "select":
				case "confirm":
				case "input":
				case "editor":
					setExtensionDialogQueue((current) => [
						...current.filter((item) => item.sessionKey === activeSessionKey),
						{ sessionKey: activeSessionKey, request: event },
					]);
					break;
				case "notify":
					showExtensionNotification(event);
					break;
				case "set_editor_text":
					if (event.text !== null) onSetEditorText(event.text);
					break;
			}
		},
		[activeSessionKey, onSetEditorText, showExtensionNotification],
	);

	const extensionDialog =
		extensionDialogQueue.find((item) => item.sessionKey === activeSessionKey)
			?.request ?? null;
	const respondToExtensionDialog = useCallback(
		async (response: {
			value?: string;
			confirmed?: boolean;
			cancelled?: boolean;
		}) => {
			const entry = extensionDialogQueue.find(
				(item) => item.sessionKey === activeSessionKey,
			);
			if (!entry) return;
			setExtensionDialogQueue((current) =>
				current.filter((item) => item !== entry),
			);
			try {
				await rpc<void>({
					type: "extension_ui_response",
					id: entry.request.id,
					...response,
				});
			} catch (error) {
				toast.error(t("chat.respondExtensionFailed"), {
					description: runtimeErrorMessage(error),
				});
			}
		},
		[activeSessionKey, extensionDialogQueue, rpc, t],
	);

	return {
		handleExtensionRequest,
		extensionDialog,
		respondToExtensionDialog,
		extensionNotifications,
		dismissExtensionNotification,
	};
}
