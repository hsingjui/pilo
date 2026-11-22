import {
	decodeNextPromptResult,
	traceNextPrompt,
	type NextPromptRequest,
	type NextPromptSettings,
} from "@shared/next-prompt";
import type { PiloClient } from "@shared/api/pilo-client";
import type {
	PiAgentState,
	PiModel,
	PiloRuntimeEvent,
} from "@shared/api/pi-runtime-types";
import { randomId } from "@shared/random-id";

type NextPromptClient = Pick<PiloClient, "requestNextPrompt">;

export type NextPromptSessionOptions = {
	client: NextPromptClient | null;
	connectionId: string;
	sessionKey: string | null;
	sessionId: string | null;
	draft: string;
	hasAttachments: boolean;
	active: boolean;
	busy: boolean;
	blocked: boolean;
	model: PiModel | null;
	loading?: boolean;
	connected?: boolean;
	getSessionState: (sessionKey: string) => Promise<PiAgentState | null>;
};

type Pending = {
	client: NextPromptClient;
	request: NextPromptRequest;
	startedAtMs: number;
	received: boolean;
	sent: boolean;
	timer: ReturnType<typeof setTimeout>;
};
type Session = {
	options: NextPromptSessionOptions;
	settings: NextPromptSettings | null;
	saving: boolean;
	busy: boolean;
	pending: Pending | null;
	result: { text: string | null; unavailable: boolean } | null;
};

function ineligibleReason(session: Session) {
	if (session.saving) return "settings_saving";
	if (session.options.blocked) return "blocked";
	if (session.options.draft) return "draft_present";
	if (session.options.hasAttachments) return "attachments_present";
	if (!session.settings?.enabled) return "disabled";
	return null;
}

export function createNextPromptSessionCache() {
	const sessions = new Map<string, Session>();
	const listeners = new Set<() => void>();
	let transport: {
		client: NextPromptClient | null;
		refreshKey: string | undefined;
		connected: boolean | undefined;
	} | null = null;
	let revision = 0;
	const publish = () => {
		revision++;
		for (const listener of listeners) listener();
	};
	const dismiss = (session: Session, reason: string) => {
		const pending = session.pending;
		session.pending = null;
		if (pending) {
			clearTimeout(pending.timer);
			traceNextPrompt(pending.received ? "release" : "cancel", {
				...pending.request,
				reason,
				elapsedMs: Date.now() - pending.startedAtMs,
			});
			if (pending.sent)
				void pending.client
					.requestNextPrompt({ ...pending.request, cancel: true })
					.catch(() => undefined);
		}
		if (session.result) {
			session.result = null;
			publish();
		}
	};
	const invalidate = (reason: string) => {
		for (const session of sessions.values()) dismiss(session, reason);
	};
	const clear = (reason: string) => {
		invalidate(reason);
		sessions.clear();
	};
	const updateSettings = (settings: NextPromptSettings, saving?: boolean) => {
		for (const session of sessions.values()) {
			if (session.options.connectionId !== settings.connectionId) continue;
			if ((session.settings?.updatedAtMs ?? -1) > settings.updatedAtMs)
				continue;
			if (saving || session.settings?.updatedAtMs !== settings.updatedAtMs)
				dismiss(session, saving ? "settings_saving" : "settings_changed");
			session.settings = settings;
			if (saving !== undefined) session.saving = saving;
		}
	};
	const start = async (session: Session, generation: number) => {
		const { client, sessionKey, getSessionState } = session.options;
		if (!client || !sessionKey || !session.settings) return;
		const request: NextPromptRequest = {
			sessionKey,
			sessionId: session.options.sessionId ?? "",
			requestId: randomId(),
			generation,
			revision: session.settings.updatedAtMs,
		};
		const pending: Pending = {
			client,
			request,
			startedAtMs: Date.now(),
			received: false,
			sent: false,
			timer: setTimeout(() => {
				if (session.pending !== pending) return;
				traceNextPrompt("timeout", {
					...request,
					elapsedMs: Date.now() - pending.startedAtMs,
				});
				dismiss(session, "client_timeout");
			}, 20_000),
		};
		session.pending = pending;
		try {
			// Resolve live identity/model and idle state even when its view was left.
			const state = await getSessionState(sessionKey);
			if (session.pending !== pending) return;
			if (
				!state ||
				state.isStreaming ||
				state.isCompacting ||
				state.pendingMessageCount > 0 ||
				!state.sessionId
			) {
				dismiss(session, "session_not_idle");
				return;
			}
			request.sessionId = state.sessionId;
			session.options = {
				...session.options,
				sessionId: state.sessionId,
				model: state.model,
			};
			pending.sent = true;
			traceNextPrompt("request", request);
			await client.requestNextPrompt(request);
		} catch {
			if (session.pending !== pending) return;
			traceNextPrompt("rejected", {
				...request,
				elapsedMs: Date.now() - pending.startedAtMs,
			});
			dismiss(session, "request_rejected");
			session.result = { text: null, unavailable: true };
			publish();
		}
	};

	return {
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		getSnapshot: () => revision,
		clear,
		invalidate,
		setTransport(
			client: NextPromptClient | null,
			refreshKey: string | undefined,
			connected: boolean | undefined,
		) {
			if (!transport || transport.client !== client) clear("transport_changed");
			else if (
				transport.refreshKey !== refreshKey ||
				transport.connected !== connected
			)
				invalidate("transport_changed");
			transport = { client, refreshKey, connected };
		},
		update(
			options: NextPromptSessionOptions,
			settings: NextPromptSettings | null,
			saving: boolean,
		) {
			if (settings) updateSettings(settings, saving);
			if (!options.sessionKey || options.loading) return;
			const previous = sessions.get(options.sessionKey);
			const session: Session = previous ?? {
				options,
				settings,
				saving,
				busy: options.busy,
				pending: null,
				result: null,
			};
			// Null identities during hydration must not undo a resolved live identity.
			const next = {
				...options,
				sessionId: options.sessionId ?? session.options.sessionId,
				model: options.model ?? session.options.model,
			};
			const old = session.options;
			if (
				old.client !== next.client ||
				old.connectionId !== next.connectionId ||
				(old.sessionId !== null && old.sessionId !== next.sessionId) ||
				(old.model !== null &&
					(old.model.provider !== next.model?.provider ||
						old.model.id !== next.model?.id)) ||
				old.draft !== next.draft ||
				old.hasAttachments !== next.hasAttachments ||
				old.blocked !== next.blocked
			)
				dismiss(session, "editor_or_config_changed");
			if (old.busy !== next.busy) {
				session.busy = next.busy;
				if (next.busy) dismiss(session, "busy");
			}
			session.options = next;
			session.saving = saving;
			sessions.delete(options.sessionKey);
			sessions.set(options.sessionKey, session);
			// Bound idle-view memory without evicting running turns or requests.
			for (const [key, cached] of sessions) {
				if (sessions.size <= 64) break;
				if (
					key === options.sessionKey ||
					cached.busy ||
					(cached.pending && !cached.pending.received)
				)
					continue;
				dismiss(cached, "cache_evicted");
				sessions.delete(key);
			}
		},
		dismiss(sessionKey: string | null, reason = "dismissed") {
			const session = sessionKey ? sessions.get(sessionKey) : null;
			if (session) dismiss(session, reason);
		},
		getResult(options: NextPromptSessionOptions) {
			const session = options.sessionKey
				? sessions.get(options.sessionKey)
				: null;
			return session &&
				options.active &&
				options.connected !== false &&
				!options.loading &&
				!options.busy &&
				!options.blocked &&
				!options.draft &&
				!options.hasAttachments &&
				!ineligibleReason(session) &&
				!session.busy
				? session.result
				: null;
		},
		handleEvent(event: PiloRuntimeEvent, live = true) {
			if (event.type === "next_prompt_settings_changed") {
				updateSettings(event.settings);
				return;
			}
			const session = event.sessionKey ? sessions.get(event.sessionKey) : null;
			if (!live || !session || transport?.connected === false) return;
			if (
				event.type === "extension_ui_request" &&
				(event.method === "select" ||
					event.method === "confirm" ||
					event.method === "input" ||
					event.method === "editor")
			) {
				session.options = { ...session.options, blocked: true };
				dismiss(session, "blocked");
				return;
			}
			if (
				event.type === "assistant_message_start" ||
				event.type === "user_message_start" ||
				event.type === "compaction_start" ||
				event.type === "auto_retry_start" ||
				event.type === "runtime_error" ||
				(event.type === "process_state" && event.state !== "running")
			) {
				session.busy =
					event.type !== "runtime_error" && event.type !== "process_state";
				dismiss(session, event.type);
				return;
			}
			if (event.type === "assistant_message_end") {
				dismiss(session, "new_completion");
				// This event represents agent_settled, not an intermediate tool-loop reply.
				session.busy = false;
				const reason = ineligibleReason(session);
				if (
					!reason &&
					event.stopReason !== "error" &&
					event.stopReason !== "aborted"
				)
					void start(session, event.generation);
				else if (session.settings?.enabled)
					traceNextPrompt("skipped", {
						sessionKey: event.sessionKey,
						generation: event.generation,
						reason: reason ?? "completion_failed",
					});
				return;
			}
			const decoded = decodeNextPromptResult(event);
			const pending = session.pending;
			if (!decoded) {
				if (
					pending &&
					event.type === "extension_ui_request" &&
					event.widgetKey === "pilo.next-prompt.v1"
				)
					traceNextPrompt("discard", {
						...pending.request,
						reason: "invalid_result",
					});
				return;
			}
			let reason: string | null = null;
			if (!pending) reason = "no_request";
			else if (
				!("generation" in event) ||
				event.generation !== pending.request.generation
			)
				reason = "generation_changed";
			else if (decoded.requestId !== pending.request.requestId)
				reason = "request_changed";
			else if (decoded.sessionId !== pending.request.sessionId)
				reason = "session_changed";
			else if (
				decoded.revision !== pending.request.revision ||
				decoded.revision !== session.settings?.updatedAtMs
			)
				reason = "revision_changed";
			else if (session.busy) reason = "busy";
			else reason = ineligibleReason(session);
			if (reason || !pending) {
				traceNextPrompt("discard", {
					sessionKey: event.sessionKey,
					requestId: decoded.requestId,
					status: decoded.status,
					reason: reason ?? "no_request",
					elapsedMs: pending ? Date.now() - pending.startedAtMs : undefined,
				});
				return;
			}
			clearTimeout(pending.timer);
			pending.received = true;
			traceNextPrompt("result", {
				...pending.request,
				status: decoded.status,
				elapsedMs: Date.now() - pending.startedAtMs,
			});
			session.result = {
				text: decoded.status === "ready" ? decoded.text : null,
				unavailable: decoded.status === "unavailable",
			};
			publish();
		},
	};
}
