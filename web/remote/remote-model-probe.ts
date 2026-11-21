import type { PiModelProbeClient } from "@/lib/api/pi-models";
import type { PiSessionSnapshot, PiloRuntimeEvent } from "@/lib/api/pi-runtime";
import { randomId } from "@/lib/utils";
import { isRpcResponse } from "./remote-app-model";
import type { WebPiloClient } from "./web-pilo-client";

export function createRemoteModelProbe(
	client: WebPiloClient,
	projectId: string,
	sessionId: string,
): PiModelProbeClient {
	const sessionKey = JSON.stringify([projectId, sessionId]);
	const handlers = new Set<(event: PiloRuntimeEvent) => void>();
	const pending = new Map<
		string,
		{
			resolve: (value: unknown) => void;
			reject: (error: unknown) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	const unlisten = client.listenChatEvents((event) => {
		if (event.sessionKey !== sessionKey) return;
		if (event.type === "rpc_message" && isRpcResponse(event.message)) {
			const id = event.message.id;
			const request = id ? pending.get(id) : undefined;
			if (request && id) {
				clearTimeout(request.timer);
				pending.delete(id);
				if (event.message.success) request.resolve(event.message.data);
				else
					request.reject(new Error(event.message.error || "Pi command failed"));
			}
		}
		for (const handler of handlers) handler(event);
	});
	const rpc = async <T>(command: Record<string, unknown>): Promise<T> => {
		const id = `remote-probe-${randomId()}`;
		const response = new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error("Pi catalog command timed out"));
			}, 10_000);
			pending.set(id, {
				resolve: (value) => resolve(value as T),
				reject,
				timer,
			});
		});
		try {
			const [, result] = await Promise.all([
				client.sendChatCommand(sessionKey, { ...command, id }),
				response,
			]);
			return result;
		} catch (error) {
			const request = pending.get(id);
			if (request) {
				clearTimeout(request.timer);
				pending.delete(id);
				request.reject(error);
			}
			throw error;
		}
	};
	let prepared: Promise<PiSessionSnapshot> | undefined;
	return {
		prepare: () =>
			(prepared ??= client.waitForEvents().then(() =>
				client.startChat({
					projectId,
					sessionKey,
					noSession: true,
					builtinExtensions: [{ id: "model-catalog" }],
				}),
			)),
		dispose: async (reason) => {
			unlisten();
			handlers.clear();
			for (const request of pending.values()) {
				clearTimeout(request.timer);
				request.reject(new Error("Pi catalog probe ended"));
			}
			pending.clear();
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
