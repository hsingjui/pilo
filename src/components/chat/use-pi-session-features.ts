import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import type { ComposerSuggestion } from "@/components/chat/chat-composer";
import type { PiExtensionNotification } from "@/components/chat/pi-extension-notifications";
import { createChatSessionClient } from "@/lib/chat-session-client";
import {
	createPiCommandSuggestions,
	createPiExtensionCommandNames,
} from "@/lib/pi-command-suggestions";
import { runtimeErrorMessage, type PiloRuntimeEvent } from "@/lib/pi-runtime";

type ChatSessionClient = ReturnType<typeof createChatSessionClient>;

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

type ExtensionWidget = {
	key: string;
	lines: string[];
	placement: "aboveEditor" | "belowEditor";
};

const MAX_EXTENSION_NOTIFICATIONS = 3;
const INFO_NOTIFICATION_DURATION_MS = 5_000;
const WARNING_NOTIFICATION_DURATION_MS = 10_000;
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
	const [extensionStatuses, setExtensionStatuses] = useState<
		Record<string, string>
	>({});
	const [extensionWidgets, setExtensionWidgets] = useState<
		Record<string, ExtensionWidget>
	>({});
	const [extensionTitle, setExtensionTitle] = useState<string | null>(null);
	const [extensionNotifications, setExtensionNotifications] = useState<
		PiExtensionNotification[]
	>([]);
	const extensionNotificationTimersRef = useRef(new Map<string, number>());

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

			setExtensionNotifications((current) =>
				[
					...current.filter((item) => item.id !== notification.id),
					notification,
				].slice(-MAX_EXTENSION_NOTIFICATIONS),
			);
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

	useEffect(() => {
		if (!active || extensionTitle === null) return;
		const previousTitle = document.title;
		document.title = extensionTitle;
		return () => {
			if (document.title === extensionTitle) document.title = previousTitle;
		};
	}, [active, extensionTitle]);

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
				case "setStatus":
					if (!event.statusKey) break;
					setExtensionStatuses((current) => {
						const next = { ...current };
						delete next[event.statusKey!];
						if (event.statusText) next[event.statusKey!] = event.statusText;
						return next;
					});
					break;
				case "setWidget":
					if (!event.widgetKey) break;
					setExtensionWidgets((current) => {
						const next = { ...current };
						if (event.widgetLines) {
							next[event.widgetKey!] = {
								key: event.widgetKey!,
								lines: event.widgetLines,
								placement:
									event.widgetPlacement === "belowEditor"
										? "belowEditor"
										: "aboveEditor",
							};
						} else {
							delete next[event.widgetKey!];
						}
						return next;
					});
					break;
				case "setTitle":
					setExtensionTitle(event.title);
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
							toast.error("上下文压缩失败", {
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
	}, [client, handleExtensionRequest, onRefreshSessionState]);

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
			toast.error("无法读取 Pi 命令", {
				description: runtimeErrorMessage(error),
			});
		} finally {
			loadingCommandsRef.current = false;
		}
	}, [client, commandsLoaded, readOnly]);

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
				toast.error("无法执行 Pi Extension 命令", {
					description: runtimeErrorMessage(error),
				});
				return matchedExtension;
			}
		},
		[client, commandsLoaded, extensionCommandNames, readOnly],
	);

	const compact = useCallback(
		async (customInstructions?: string) => {
			if (readOnly || compacting) return;
			setCompacting(true);
			try {
				await client.ensure();
				const result = await client.compactPiSession(customInstructions);
				toast.success("上下文已压缩", {
					description: `${result.tokensBefore.toLocaleString()} → ${result.estimatedTokensAfter.toLocaleString()} tokens`,
				});
				await onRefreshSessionState();
			} catch (error) {
				toast.error("无法压缩上下文", {
					description: runtimeErrorMessage(error),
				});
			} finally {
				setCompacting(false);
			}
		},
		[client, compacting, onRefreshSessionState, readOnly],
	);

	const abortRetry = useCallback(async () => {
		try {
			await client.abortPiRetry();
			setRetryState(null);
		} catch (error) {
			toast.error("无法停止重试", { description: runtimeErrorMessage(error) });
		}
	}, [client]);

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
				toast.error("无法响应 Pi Extension", {
					description: runtimeErrorMessage(error),
				});
			}
		},
		[client, extensionDialogQueue],
	);

	const statusText = useMemo(() => {
		if (retryState) {
			const target = retryState.kind === "summary" ? "摘要" : "请求";
			return `${target}重试 ${retryState.attempt}/${retryState.maxAttempts}`;
		}
		const statuses = Object.values(extensionStatuses);
		return statuses[statuses.length - 1] ?? "";
	}, [extensionStatuses, retryState]);

	const widgets = useMemo(
		() => Object.values(extensionWidgets),
		[extensionWidgets],
	);

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
		widgets,
		extensionNotifications,
		dismissExtensionNotification,
	};
}
