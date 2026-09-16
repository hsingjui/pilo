import { invoke } from "@tauri-apps/api/core";
import {
	toPiImageContents,
	type ChatImageAttachment,
} from "@/lib/chat-submission";
import {
	listenRuntimeEvents,
	requestPiRpc,
	type PiAgentState,
	type PiCommand,
	type PiCompactionResult,
	type PiModel,
	type PiModelCycleResult,
	type PiSessionEntries,
	type PiSessionSnapshot,
	type PiSessionStats,
	type PiThinkingLevel,
	type PiloRuntimeEvent,
} from "@/lib/pi-runtime";

const DEFAULT_PI_RPC_TIMEOUT_MS = 10_000;
const COMPACTION_PI_RPC_TIMEOUT_MS = 120_000;
let chatClientSequence = 0;

export type ChatSessionClientOptions = {
	noSession?: boolean;
	owner?: string;
};

function traceChatClient(
	stage: string,
	sessionKey: string,
	detail: Record<string, unknown> = {},
) {
	if (!import.meta.env.DEV) return;
	void invoke("debug_runtime_trace_log", {
		payload: JSON.stringify({ stage, sessionKey, ...detail }),
	}).catch(() => undefined);
}

export type ChatSessionRuntimeState = {
	sessionKey: string;
	projectId: string;
	sessionPath?: string | null;
	prepared: boolean;
	initialized: boolean;
	activeTurn: boolean;
	snapshot: PiSessionSnapshot;
};

export function listChatSessionRuntimeStates() {
	return invoke<ChatSessionRuntimeState[]>("chat_session_states");
}

function chatSessionKey(projectId: string, sessionId: string) {
	return JSON.stringify([projectId, sessionId]);
}

function createRegisteredChatSessionClient(
	projectId: string,
	sessionId: string,
	sessionPath?: string,
	options: ChatSessionClientOptions = {},
) {
	const sessionKey = chatSessionKey(projectId, sessionId);
	const noSession = options.noSession ?? false;
	chatClientSequence += 1;
	const clientId = chatClientSequence;
	let resumePath = sessionPath;
	let pendingPrepare: Promise<PiSessionSnapshot> | undefined;
	let pendingEnsure: Promise<PiSessionSnapshot> | undefined;
	const rpc = <T>(
		command: Record<string, unknown>,
		timeoutMs = DEFAULT_PI_RPC_TIMEOUT_MS,
	) => requestPiRpc<T>(command, timeoutMs, sessionKey);
	const getPiAgentState = async () => {
		const state = await rpc<PiAgentState>({ type: "get_state" });
		if (state.sessionFile) resumePath = state.sessionFile;
		return state;
	};

	const client = {
		clientId,
		sessionKey,
		projectId,
		sessionId,
		noSession,
		updateSessionPath(nextSessionPath?: string) {
			if (!nextSessionPath || nextSessionPath === resumePath) return;
			traceChatClient("client.path.update", sessionKey, {
				clientId,
				hadResumePath: Boolean(resumePath),
			});
			resumePath = nextSessionPath;
		},
		state: () =>
			invoke<ChatSessionRuntimeState | null>("chat_session_state", {
				sessionKey,
			}),
		prepare: (): Promise<PiSessionSnapshot> => {
			traceChatClient("client.prepare.request", sessionKey, {
				clientId,
				hasResumePath: Boolean(resumePath),
				pendingEnsure: Boolean(pendingEnsure),
				pendingPrepare: Boolean(pendingPrepare),
			});
			if (pendingEnsure) return pendingEnsure;
			if (pendingPrepare) return pendingPrepare;
			pendingPrepare = invoke<PiSessionSnapshot>("chat_session_prepare", {
				projectId,
				sessionKey,
				sessionPath: resumePath,
				noSession,
			}).finally(() => {
				pendingPrepare = undefined;
			});
			return pendingPrepare;
		},
		ensure: (): Promise<PiSessionSnapshot> => {
			traceChatClient("client.ensure.request", sessionKey, {
				clientId,
				hasResumePath: Boolean(resumePath),
				pendingEnsure: Boolean(pendingEnsure),
			});
			if (pendingEnsure) return pendingEnsure;
			pendingEnsure = invoke<PiSessionSnapshot>("chat_session_start", {
				projectId,
				sessionKey,
				sessionPath: resumePath,
				noSession,
			}).finally(() => {
				pendingEnsure = undefined;
			});
			return pendingEnsure;
		},
		stop: (reason = "client_stop") => {
			traceChatClient("client.stop.request", sessionKey, { clientId, reason });
			return invoke<void>("chat_session_stop", { sessionKey, reason });
		},
		dispose: (reason = "client_dispose") => {
			releaseChatSessionClient(sessionKey, client, reason);
			traceChatClient("client.stop.request", sessionKey, { clientId, reason });
			return invoke<void>("chat_session_stop", { sessionKey, reason });
		},
		listen: (handler: (event: PiloRuntimeEvent) => void) =>
			listenRuntimeEvents(handler, { sessionKey }),
		getPiAgentState,
		getPiMessages: () => rpc<{ messages: unknown[] }>({ type: "get_messages" }),
		getPiEntries: () => rpc<PiSessionEntries>({ type: "get_entries" }),
		getPiSessionStats: () => rpc<PiSessionStats>({ type: "get_session_stats" }),
		getPiCommands: () =>
			rpc<{ commands: PiCommand[] }>({ type: "get_commands" }),
		executePiCommand: (message: string) =>
			invoke<void>("chat_session_send_rpc", {
				sessionKey,
				command: { type: "prompt", message },
			}),
		getAvailablePiModels: () =>
			rpc<{ models: PiModel[] }>({ type: "get_available_models" }),
		getAvailablePiThinkingLevels: () =>
			rpc<{ levels: PiThinkingLevel[] }>({
				type: "get_available_thinking_levels",
			}),
		setPiModel: (model: Pick<PiModel, "provider" | "id">) =>
			rpc<PiModel>({
				type: "set_model",
				provider: model.provider,
				modelId: model.id,
			}),
		cyclePiModel: () => rpc<PiModelCycleResult | null>({ type: "cycle_model" }),
		setPiThinkingLevel: (level: PiThinkingLevel) =>
			rpc<void>({ type: "set_thinking_level", level }),
		setPiSessionName: (name: string) =>
			rpc<void>({ type: "set_session_name", name }),
		forkPiSession: (entryId: string) =>
			rpc<{ text: string; cancelled: boolean }>({
				type: "fork",
				entryId,
			}),
		clonePiSession: () =>
			rpc<{ cancelled: boolean }>({
				type: "clone",
			}),
		sendPiPrompt: (
			message: string,
			images: readonly ChatImageAttachment[] = [],
		) =>
			invoke<void>("chat_session_send_rpc", {
				sessionKey,
				command: {
					type: "prompt",
					message,
					...(images.length > 0 ? { images: toPiImageContents(images) } : {}),
				},
			}),
		sendPiSteer: (
			message: string,
			images: readonly ChatImageAttachment[] = [],
		) =>
			rpc<void>({
				type: "steer",
				message,
				...(images.length > 0 ? { images: toPiImageContents(images) } : {}),
			}),
		sendPiFollowUp: (
			message: string,
			images: readonly ChatImageAttachment[] = [],
		) =>
			rpc<void>({
				type: "follow_up",
				message,
				...(images.length > 0 ? { images: toPiImageContents(images) } : {}),
			}),
		abortPiReply: (reason = "abort_reply") => {
			traceChatClient("client.abort.request", sessionKey, {
				clientId,
				reason,
				command: "abort",
			});
			return rpc<void>({ type: "abort" });
		},
		compactPiSession: (customInstructions?: string) =>
			rpc<PiCompactionResult>(
				{
					type: "compact",
					...(customInstructions?.trim()
						? { customInstructions: customInstructions.trim() }
						: {}),
				},
				COMPACTION_PI_RPC_TIMEOUT_MS,
			),
		abortPiRetry: (reason = "abort_retry") => {
			traceChatClient("client.abort.request", sessionKey, {
				clientId,
				reason,
				command: "abort_retry",
			});
			return rpc<void>({ type: "abort_retry" });
		},
		respondToExtensionUi: (
			id: string,
			response: { value?: string; confirmed?: boolean; cancelled?: boolean },
		) =>
			invoke<void>("chat_session_send_rpc", {
				sessionKey,
				command: { type: "extension_ui_response", id, ...response },
			}),
		clearPiQueue: () => rpc<void>({ type: "clear_queue" }),
	};

	return client;
}

export type ChatSessionClient = ReturnType<
	typeof createRegisteredChatSessionClient
>;

const chatSessionClientRegistry = new Map<string, ChatSessionClient>();

function releaseChatSessionClient(
	sessionKey: string,
	expected: ChatSessionClient | undefined,
	reason: string,
) {
	const current = chatSessionClientRegistry.get(sessionKey);
	if (!current || (expected && current !== expected)) return false;
	chatSessionClientRegistry.delete(sessionKey);
	traceChatClient("client.release", sessionKey, {
		clientId: current.clientId,
		reason,
		registrySize: chatSessionClientRegistry.size,
	});
	return true;
}

export function stopChatSession(
	projectId: string,
	sessionId: string,
	reason = "stop_chat_session",
) {
	const sessionKey = chatSessionKey(projectId, sessionId);
	releaseChatSessionClient(sessionKey, undefined, reason);
	traceChatClient("client.stop.request", sessionKey, { reason });
	return invoke<void>("chat_session_stop", { sessionKey, reason });
}

export function createChatSessionClient(
	projectId: string,
	sessionId: string,
	sessionPath?: string,
	options: ChatSessionClientOptions = {},
): ChatSessionClient {
	const sessionKey = chatSessionKey(projectId, sessionId);
	const noSession = options.noSession ?? false;
	const owner = options.owner ?? "unspecified";
	const existing = chatSessionClientRegistry.get(sessionKey);
	if (existing) {
		existing.updateSessionPath(sessionPath);
		traceChatClient("client.reuse", sessionKey, {
			clientId: existing.clientId,
			owner,
			hasSessionPath: Boolean(sessionPath),
			noSession,
			noSessionMismatch: existing.noSession !== noSession,
			registrySize: chatSessionClientRegistry.size,
		});
		return existing;
	}

	const client = createRegisteredChatSessionClient(
		projectId,
		sessionId,
		sessionPath,
		options,
	);
	chatSessionClientRegistry.set(sessionKey, client);
	traceChatClient("client.create", sessionKey, {
		clientId: client.clientId,
		owner,
		projectId,
		sessionId,
		hasSessionPath: Boolean(sessionPath),
		noSession,
		registrySize: chatSessionClientRegistry.size,
	});
	return client;
}
