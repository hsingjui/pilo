import type { PiModelProbeClient } from "@/lib/api/pi-models-probe";
import type {
	PiSessionSnapshot,
	PiloRuntimeEvent,
} from "@/lib/api/pi-runtime-types";
import type { PiloClientStartChatInput } from "@/lib/api/pilo-client";
import { chatSessionKey } from "@/lib/api/chat-session-key";
import { requestPiRpcReply, type PiCommandClient } from "./chat-rpc";

/** The model-catalog probe RPC wait; the same 10 s the Tauri probe uses. */
const PROBE_RPC_TIMEOUT_MS = 10_000;

type ModelProbeHost = PiCommandClient & {
	startChat: (input: PiloClientStartChatInput) => Promise<PiSessionSnapshot>;
	stopChat: (sessionKey: string, reason?: string) => Promise<unknown>;
};

/**
 * A `PiModelProbeClient` over the nsh client's event stream and command
 * channel: starts a noSession Pi on `startChat`, answers RPCs with
 * `requestPiRpc`, and fans session events out to the probe's listeners.
 */
export function createNshModelProbe(
	client: ModelProbeHost,
	projectId: string,
	sessionId: string,
): PiModelProbeClient {
	const sessionKey = chatSessionKey(projectId, sessionId);
	const handlers = new Set<(event: PiloRuntimeEvent) => void>();
	let connected: Promise<() => void> | undefined;
	let disconnect: (() => void) | undefined;
	const connect = () =>
		(connected ??= client
			.connectEvents({
				onMessage: (message) => {
					if (message.type !== "events") return;
					for (const event of message.events) {
						if (event.sessionKey !== sessionKey) continue;
						for (const handler of handlers) handler(event);
					}
				},
				onStatus: () => {},
			})
			.then((disposer) => {
				disconnect = disposer;
				return disposer;
			}));
	const rpc = async <T>(command: Record<string, unknown>): Promise<T> => {
		const reply = await requestPiRpcReply<T>(
			client,
			sessionKey,
			command,
			PROBE_RPC_TIMEOUT_MS,
		);
		if (reply === null) throw new Error("Pi catalog command timed out");
		return reply.data as T;
	};
	let prepared: Promise<PiSessionSnapshot> | undefined;
	return {
		prepare: () =>
			(prepared ??= connect().then(() =>
				client.startChat({
					projectId,
					sessionKey,
					noSession: true,
					builtinExtensions: [{ id: "model-catalog" }],
				}),
			)),
		dispose: async (reason) => {
			handlers.clear();
			disconnect?.();
			connected = undefined;
			disconnect = undefined;
			if (prepared) await client.stopChat(sessionKey, reason);
		},
		listen: async (handler) => {
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
			};
		},
		getPiCommands: () => rpc({ type: "get_commands" }),
		getAvailablePiModels: () => rpc({ type: "get_available_models" }),
		getPiAgentState: () => rpc({ type: "get_state" }),
		getAvailablePiThinkingLevels: () =>
			rpc({ type: "get_available_thinking_levels" }),
		cyclePiModel: () => rpc({ type: "cycle_model" }),
		setPiModel: (model) =>
			rpc({ type: "set_model", provider: model.provider, modelId: model.id }),
		setPiThinkingLevel: (level) => rpc({ type: "set_thinking_level", level }),
		executePiCommand: (message) =>
			client.sendChatCommand(sessionKey, { type: "prompt", message }),
		respondToExtensionUi: (id, response) =>
			client.sendChatCommand(sessionKey, {
				type: "extension_ui_response",
				id,
				...response,
			}),
	};
}
