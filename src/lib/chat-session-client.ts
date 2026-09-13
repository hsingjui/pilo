import { invoke } from "@tauri-apps/api/core";
import {
	listenRuntimeEvents,
	requestPiRpc,
	type PiAgentState,
	type PiModel,
	type PiSessionSnapshot,
	type PiSessionStats,
	type PiThinkingLevel,
	type PiloRuntimeEvent,
} from "@/lib/pi-runtime";

export function stopChatSession(projectId: string, sessionId: string) {
	const sessionKey = JSON.stringify([projectId, sessionId]);
	return invoke<void>("chat_session_stop", { sessionKey });
}

export function createChatSessionClient(
	projectId: string,
	sessionId: string,
	sessionPath?: string,
) {
	const sessionKey = JSON.stringify([projectId, sessionId]);
	let resumePath = sessionPath;
	let pending: Promise<PiSessionSnapshot> | undefined;
	const rpc = <T>(command: Record<string, unknown>) =>
		requestPiRpc<T>(command, 10_000, sessionKey);
	const getPiAgentState = async () => {
		const state = await rpc<PiAgentState>({ type: "get_state" });
		if (state.sessionFile) resumePath = state.sessionFile;
		return state;
	};

	return {
		sessionKey,
		ensure: (): Promise<PiSessionSnapshot> => {
			if (pending) return pending;
			pending = invoke<PiSessionSnapshot>("chat_session_start", {
				projectId,
				sessionKey,
				sessionPath: resumePath,
			}).finally(() => {
				pending = undefined;
			});
			return pending;
		},
		stop: () => invoke<void>("chat_session_stop", { sessionKey }),
		listen: (handler: (event: PiloRuntimeEvent) => void) =>
			listenRuntimeEvents(handler, { sessionKey }),
		getPiAgentState,
		getPiMessages: () => rpc<{ messages: unknown[] }>({ type: "get_messages" }),
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
		setPiThinkingLevel: (level: PiThinkingLevel) =>
			rpc<void>({ type: "set_thinking_level", level }),
		setPiSessionName: (name: string) =>
			rpc<void>({ type: "set_session_name", name }),
		sendPiPrompt: (message: string) =>
			invoke<void>("chat_session_send_rpc", {
				sessionKey,
				command: { type: "prompt", message },
			}),
		sendPiSteer: (message: string) => rpc<void>({ type: "steer", message }),
		sendPiFollowUp: (message: string) =>
			rpc<void>({ type: "follow_up", message }),
		abortPiReply: () => rpc<void>({ type: "abort" }),
	};
}
