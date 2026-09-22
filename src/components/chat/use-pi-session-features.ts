import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { i18n } from "../../i18n/index.ts";

import type { ComposerSuggestion } from "@/components/chat/chat-composer";
import type { PiExtensionNotification } from "@/components/chat/pi-extension-notifications";
import { createChatSessionClient } from "@/lib/chat-session-client";
import {
	createPiCommandSuggestions,
	createPiExtensionCommandNames,
} from "@/lib/pi-command-suggestions";
import { runtimeErrorMessage, type PiloRuntimeEvent } from "@/lib/pi-runtime";

type ChatSessionClient = ReturnType<typeof createChatSessionClient>;

function extensionNotificationDedupKey(
	notification: PiExtensionNotification,
): string {
	return `${notification.type}:${notification.message}`;
}

export type PiExtensionDialogRequest = Extract<
	PiloRuntimeEvent,
	{ type: "extension_ui_request" }
>;

type RetryState = {
	kind: "agent" | "summary";
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
};

const MAX_EXTENSION_NOTIFICATIONS = 3;
const INFO_NOTIFICATION_DURATION_MS = 5_000;
const WARNING_NOTIFICATION_DURATION_MS = 10_000;
const EXTENSION_NOTIFICATION_DEDUP_WINDOW_MS = 10_000;
type UsePiSessionFeaturesOptions = {
	client: ChatSessionClient;
	active: boolean;
	readOnly?: boolean;
	onSetEditorText: (text: string) => void;
	onRefreshSessionState: () => Promise<void>;
};

export function usePiSessionFeatures({
	client,
	active,
	readOnly = false,
	onSetEditorText,
	onRefreshSessionState,
}: UsePiSessionFeaturesOptions) {
	const { t } = useTranslation();
	const [commandSuggestions, setCommandSuggestions] = useState<
		ComposerSuggestion[]
	>([]);
	const [extensionCommandNames, setExtensionCommandNames] = useState<
		Set<string>
	>(() => new Set());
	const [commandsLoaded, setCommandsLoaded] = useState(false);
	const loadingCommandsRef = useRef(false);
	const [compacting, setCompacting] = useState(false);
	const [retryState, setRetryState] = useState<RetryState | null>(null);
	const [extensionDialogQueue, setExtensionDialogQueue] = useState<
		PiExtensionDialogRequest[]
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

	const scheduleExtensionNotificationDismiss = useCallback(
		(notification: PiExtensionNotification) => {
			const existingTimer = extensionNotificationTimersRef.current.get(
				notification.id,
			);
			if (existingTimer !== undefined) {
				window.clearTimeout(existingTimer);
				extensionNotificationTimersRef.current.delete(notification.id);
			}
			if (notification.type === "error") return;

			const duration =
				notification.type === "warning"
					? WARNING_NOTIFICATION_DURATION_MS
					: INFO_NOTIFICATION_DURATION_MS;
			const timer = window.setTimeout(
				() => dismissExtensionNotification(notification.id),
				duration,
			);
			extensionNotificationTimersRef.current.set(notification.id, timer);
		},
		[dismissExtensionNotification],
	);

	const showExtensionNotification = useCallback(
		(event: PiExtensionDialogRequest) => {
			const type = event.notifyType ?? "info";
			const notification: PiExtensionNotification = {
				id: event.id,
				message: event.message || event.title || "Pi extension notification",
				type,
			};

			const dedupKey = extensionNotificationDedupKey(notification);
			const now = Date.now();
			for (const [key, seenAt] of extensionNotificationLastSeenRef.current) {
				if (now - seenAt >= EXTENSION_NOTIFICATION_DEDUP_WINDOW_MS) {
					extensionNotificationLastSeenRef.current.delete(key);
				}
			}
			const lastSeenAt = extensionNotificationLastSeenRef.current.get(dedupKey);
			// Dropped repeats refresh the timestamp too, so a continuous burst of
			// identical notifications only ever shows the first one.
			extensionNotificationLastSeenRef.current.set(dedupKey, now);
			if (
				lastSeenAt !== undefined &&
				now - lastSeenAt < EXTENSION_NOTIFICATION_DEDUP_WINDOW_MS
			) {
				return;
			}

			setExtensionNotifications((current) => {
				// Error notifications stay on screen until dismissed, so an
				// identical repeat outside the window must not stack either.
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
		if (!active) {
			for (const timer of extensionNotificationTimersRef.current.values()) {
				window.clearTimeout(timer);
			}
			extensionNotificationTimersRef.current.clear();
			return;
		}

		const notificationsById = new Map(
			extensionNotifications.map((notification) => [
				notification.id,
				notification,
			]),
		);
		for (const [id, timer] of extensionNotificationTimersRef.current) {
			const notification = notificationsById.get(id);
			if (!notification || notification.type === "error") {
				window.clearTimeout(timer);
				extensionNotificationTimersRef.current.delete(id);
			}
		}

		for (const notification of extensionNotifications) {
			if (!extensionNotificationTimersRef.current.has(notification.id)) {
				scheduleExtensionNotificationDismiss(notification);
			}
		}
	}, [active, extensionNotifications, scheduleExtensionNotificationDismiss]);

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
					setExtensionDialogQueue((current) => [...current, event]);
					break;
				case "notify":
					showExtensionNotification(event);
					break;
				case "set_editor_text":
					if (event.text !== null) onSetEditorText(event.text);
					break;
			}
		},
		[onSetEditorText, showExtensionNotification],
	);

	useEffect(() => {
		let disposed = false;
		let unlisten: (() => void) | undefined;
		void client
			.listen((event) => {
				if (disposed) return;
				switch (event.type) {
					case "extension_ui_request":
						handleExtensionRequest(event);
						break;
					case "compaction_start":
						setCompacting(true);
						break;
					case "compaction_end":
						setCompacting(false);
						void onRefreshSessionState().catch(() => undefined);
						if (event.errorMessage) {
							toast.error(t("chat.compactFailed"), {
								description: event.errorMessage,
							});
						}
						break;
					case "auto_retry_start":
						setRetryState({
							kind: "agent",
							attempt: event.attempt,
							maxAttempts: event.maxAttempts,
							delayMs: event.delayMs,
							errorMessage: event.errorMessage,
						});
						break;
					case "auto_retry_end":
						setRetryState(null);
						break;
					case "summarization_retry_scheduled":
						setRetryState({
							kind: "summary",
							attempt: event.attempt,
							maxAttempts: event.maxAttempts,
							delayMs: event.delayMs,
							errorMessage: event.errorMessage,
						});
						break;
					case "summarization_retry_finished":
						setRetryState(null);
						break;
					case "runtime_error":
						setCompacting(false);
						setRetryState(null);
						break;
				}
			})
			.then((stop) => {
				if (disposed) stop();
				else unlisten = stop;
			})
			.catch((error) =>
				console.warn("Failed to listen to Pi session features", error),
			);
		return () => {
			disposed = true;
			unlisten?.();
		};
	}, [client, handleExtensionRequest, onRefreshSessionState, t]);

	const loadCommands = useCallback(async () => {
		if (readOnly || commandsLoaded || loadingCommandsRef.current) return;
		loadingCommandsRef.current = true;
		try {
			await client.ensure();
			const result = await client.getPiCommands();
			setExtensionCommandNames(createPiExtensionCommandNames(result.commands));
			setCommandSuggestions(createPiCommandSuggestions(result.commands));
			setCommandsLoaded(true);
		} catch (error) {
			toast.error(t("chat.readCommandsFailed"), {
				description: runtimeErrorMessage(error),
			});
		} finally {
			loadingCommandsRef.current = false;
		}
	}, [client, commandsLoaded, readOnly, t]);

	const tryExecuteExtensionCommand = useCallback(
		async (message: string) => {
			if (readOnly) return false;
			const trimmed = message.trim();
			if (!trimmed.startsWith("/")) return false;
			const commandName = trimmed.slice(1).split(/\s+/, 1)[0];
			let matchedExtension = false;
			try {
				await client.ensure();
				let knownExtensionCommands = extensionCommandNames;
				if (!commandsLoaded) {
					const result = await client.getPiCommands();
					knownExtensionCommands = createPiExtensionCommandNames(
						result.commands,
					);
					setExtensionCommandNames(knownExtensionCommands);
					setCommandSuggestions(createPiCommandSuggestions(result.commands));
					setCommandsLoaded(true);
				}
				if (!knownExtensionCommands.has(commandName)) return false;
				matchedExtension = true;
				await client.executePiCommand(trimmed);
				return true;
			} catch (error) {
				toast.error(t("chat.executeExtensionFailed"), {
					description: runtimeErrorMessage(error),
				});
				return matchedExtension;
			}
		},
		[client, commandsLoaded, extensionCommandNames, readOnly, t],
	);

	const compact = useCallback(
		async (customInstructions?: string) => {
			if (readOnly || compacting) return;
			setCompacting(true);
			try {
				await client.ensure();
				const result = await client.compactPiSession(customInstructions);
				toast.success(t("chat.compactSuccess"), {
					description: `${result.tokensBefore.toLocaleString(i18n.language)} → ${result.estimatedTokensAfter.toLocaleString(i18n.language)} tokens`,
				});
				await onRefreshSessionState();
			} catch (error) {
				toast.error(t("chat.compactFailedAction"), {
					description: runtimeErrorMessage(error),
				});
			} finally {
				setCompacting(false);
			}
		},
		[client, compacting, onRefreshSessionState, readOnly, t],
	);

	const abortRetry = useCallback(async () => {
		try {
			await client.abortPiRetry("user_abort_retry");
			setRetryState(null);
		} catch (error) {
			toast.error(t("chat.stopRetryFailed"), {
				description: runtimeErrorMessage(error),
			});
		}
	}, [client, t]);

	const extensionDialog = extensionDialogQueue[0] ?? null;
	const respondToExtensionDialog = useCallback(
		async (response: {
			value?: string;
			confirmed?: boolean;
			cancelled?: boolean;
		}) => {
			const request = extensionDialogQueue[0];
			if (!request) return;
			setExtensionDialogQueue((current) => current.slice(1));
			try {
				await client.respondToExtensionUi(request.id, response);
			} catch (error) {
				toast.error(t("chat.respondExtensionFailed"), {
					description: runtimeErrorMessage(error),
				});
			}
		},
		[client, extensionDialogQueue, t],
	);

	const statusText = retryState
		? t("chat.statusRetry", {
				kind:
					retryState.kind === "summary"
						? t("chat.kindSummary")
						: t("chat.kindRequest"),
				attempt: retryState.attempt,
				maxAttempts: retryState.maxAttempts,
			})
		: "";

	return {
		commandSuggestions,
		loadCommands,
		tryExecuteExtensionCommand,
		compacting,
		compact,
		retryState,
		abortRetry,
		extensionDialog,
		respondToExtensionDialog,
		statusText,
		extensionNotifications,
		dismissExtensionNotification,
	};
}
