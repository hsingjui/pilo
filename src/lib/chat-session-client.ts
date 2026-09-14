import { invoke } from "@tauri-apps/api/core";
import {
	toPiImageContents,
	type ChatImageAttachment,
} from "@/lib/chat-submission";
import {
	listenRuntimeEvents,
	requestPiRpc,
	type PiAgentState,
	type PiModel,
	type PiModelCycleResult,
	type PiSessionEntries,
	type PiSessionSnapshot,
	type PiSessionStats,
	type PiThinkingLevel,
	type PiloRuntimeEvent,
} from "@/lib/pi-runtime";

export type ChatSessionRuntimeState = {
	projectId: string;
	sessionPath?: string | null;
	prepared: boolean;
	initialized: boolean;
	snapshot: PiSessionSnapshot;
};

export function stopChatSession(projectId: string, sessionId: string) {
	const sessionKey = JSON.stringify([projectId, sessionId]);
	return invoke<void>("chat_session_stop", { sessionKey });
}

export function createChatSessionClient(
	projectId: string,
	sessionId: string,
	sessionPath?: string,
	options: { noSession?: boolean } = {},
) {
	const sessionKey = JSON.stringify([projectId, sessionId]);
	const noSession = options.noSession ?? false;
	let resumePath = sessionPath;
	let pendingPrepare: Promise<PiSessionSnapshot> | undefined;
	let pendingEnsure: Promise<PiSessionSnapshot> | undefined;
	const rpc = <T>(command: Record<string, unknown>) =>
		requestPiRpc<T>(command, 10_000, sessionKey);
	const getPiAgentState = async () => {
		const state = await rpc<PiAgentState>({ type: "get_state" });
		if (state.sessionFile) resumePath = state.sessionFile;
		return state;
	};

	return {
		sessionKey,
		state: () =>
			invoke<ChatSessionRuntimeState | null>("chat_session_state", {
				sessionKey,
			}),
		prepare: (): Promise<PiSessionSnapshot> => {
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
		stop: () => invoke<void>("chat_session_stop", { sessionKey }),
		listen: (handler: (event: PiloRuntimeEvent) => void) =>
			listenRuntimeEvents(handler, { sessionKey }),
		getPiAgentState,
		getPiMessages: () => rpc<{ messages: unknown[] }>({ type: "get_messages" }),
		getPiEntries: () => rpc<PiSessionEntries>({ type: "get_entries" }),
		getPiSessionStats: () => rpc<PiSessionStats>({ type: "get_session_stats" }),
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
		abortPiReply: () => rpc<void>({ type: "abort" }),
		clearPiQueue: () => rpc<void>({ type: "clear_queue" }),
	};
}
