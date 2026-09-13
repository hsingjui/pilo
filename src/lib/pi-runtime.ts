import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const RUNTIME_EVENT_NAME = "pilo://runtime";

export type PiProcessState =
	| "stopped"
	| "starting"
	| "running"
	| "stopping"
	| "failed";

export type RuntimeErrorCode =
	| "spawn_failed"
	| "process_io"
	| "rpc_decode"
	| "rpc_framing"
	| "rpc_response"
	| "process_exit"
	| "process_wait";

export type SshAuthMethod = "agent" | "password" | "key";

export type SshTarget =
	| { type: "config_host"; host: string; authMethod: SshAuthMethod }
	| {
			type: "direct";
			hostname: string;
			port: number | null;
			user: string | null;
			identityFile: string | null;
			authMethod: SshAuthMethod;
			proxyJump: string | null;
	  };

export type ConnectionKind =
	| { type: "local" }
	| { type: "wsl"; distro: string }
	| { type: "ssh"; target: SshTarget };

export type Connection = {
	id: string;
	name: string;
	kind: ConnectionKind;
};

export type PiSessionSnapshot = {
	generation: number;
	state: PiProcessState;
	connection: Connection | null;
	projectId: string | null;
};

export type PiThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

export const PI_THINKING_LEVELS: PiThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export type PiModel = {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	/** Pi-resolved default for this model (per-model override > global default, clamped). */
	defaultThinkingLevel?: PiThinkingLevel;
	/** Thinking levels Pi reports as available after this model is selected. */
	thinkingLevels?: PiThinkingLevel[];
	/** Pi scoped-model cycle order. null means scope was resolved and this model is outside it. */
	scopeOrder?: number | null;
};

export type PiModelCycleResult = {
	model: PiModel;
	thinkingLevel: PiThinkingLevel;
	isScoped: boolean;
};

export type PiAgentState = {
	model: PiModel | null;
	thinkingLevel: PiThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	sessionFile?: string;
	sessionId?: string;
	sessionName?: string;
	messageCount: number;
	pendingMessageCount: number;
};

export type WslDistribution = {
	name: string;
};

export type PiloRuntimeEvent = {
	sessionKey?: string;
	projectId?: string;
} & (
	| {
			type: "process_state";
			generation: number;
			state: PiProcessState;
	  }
	| {
			type: "rpc_message";
			generation: number;
			message: unknown;
	  }
	| {
			type: "user_message_start";
			generation: number;
			text: string;
	  }
	| {
			type: "assistant_message_start";
			generation: number;
	  }
	| {
			type: "assistant_text_delta";
			generation: number;
			delta: string;
	  }
	| {
			type: "assistant_text_snapshot";
			generation: number;
			text: string;
	  }
	| {
			type: "assistant_thinking_start";
			generation: number;
	  }
	| {
			type: "assistant_thinking_delta";
			generation: number;
			delta: string;
	  }
	| {
			type: "assistant_thinking_end";
			generation: number;
	  }
	| {
			type: "tool_execution_start";
			generation: number;
			toolCallId: string;
			toolName: string;
			args: unknown;
	  }
	| {
			type: "tool_execution_update";
			generation: number;
			toolCallId: string;
			toolName: string;
			args: unknown;
			partialResult: unknown;
	  }
	| {
			type: "tool_execution_end";
			generation: number;
			toolCallId: string;
			toolName: string;
			result: unknown;
			isError: boolean;
	  }
	| {
			type: "assistant_message_end";
			generation: number;
			stopReason: string | null;
			errorMessage: string | null;
	  }
	| {
			type: "queue_update";
			generation: number;
			steering: string[];
			followUp: string[];
	  }
	| {
			type: "runtime_log";
			generation: number;
			stream: "stderr";
			message: string;
	  }
	| {
			type: "runtime_error";
			generation: number;
			code: RuntimeErrorCode;
			message: string;
	  }
);

type RuntimeEventHandler = (event: PiloRuntimeEvent) => void;

const globalRuntimeEventHandlers = new Set<RuntimeEventHandler>();
const runtimeEventHandlersBySession = new Map<
	string | undefined,
	Set<RuntimeEventHandler>
>();
let runtimeListenerReady: Promise<void> | null = null;

function invokeRuntimeEventHandlers(
	handlers: Iterable<RuntimeEventHandler>,
	event: PiloRuntimeEvent,
) {
	for (const handler of handlers) {
		try {
			handler(event);
		} catch (error) {
			console.error("Runtime event handler failed", error);
		}
	}
}

function ensureRuntimeEventListener() {
	if (runtimeListenerReady) return runtimeListenerReady;
	runtimeListenerReady = listen<PiloRuntimeEvent>(
		RUNTIME_EVENT_NAME,
		({ payload }) => {
			invokeRuntimeEventHandlers(globalRuntimeEventHandlers, payload);
			const scoped = runtimeEventHandlersBySession.get(payload.sessionKey);
			if (scoped) invokeRuntimeEventHandlers(scoped, payload);
		},
	)
		.then(() => undefined)
		.catch((error) => {
			runtimeListenerReady = null;
			throw error;
		});
	return runtimeListenerReady;
}

export async function listenRuntimeEvents(
	handler: RuntimeEventHandler,
	scope?: { sessionKey: string | undefined },
): Promise<UnlistenFn> {
	const handlers = scope
		? (runtimeEventHandlersBySession.get(scope.sessionKey) ?? new Set())
		: globalRuntimeEventHandlers;
	if (scope && !runtimeEventHandlersBySession.has(scope.sessionKey)) {
		runtimeEventHandlersBySession.set(scope.sessionKey, handlers);
	}
	handlers.add(handler);
	try {
		await ensureRuntimeEventListener();
	} catch (error) {
		handlers.delete(handler);
		if (scope && handlers.size === 0) {
			runtimeEventHandlersBySession.delete(scope.sessionKey);
		}
		throw error;
	}
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		handlers.delete(handler);
		if (scope && handlers.size === 0) {
			runtimeEventHandlersBySession.delete(scope.sessionKey);
		}
	};
}

let rpcRequestSequence = 0;

type PiRpcResponse<T> = {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	data?: T;
	error?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export async function requestPiRpc<T>(
	command: Record<string, unknown>,
	timeoutMs = 10_000,
	sessionKey?: string,
): Promise<T> {
	rpcRequestSequence += 1;
	const id = `pilo-${Date.now()}-${rpcRequestSequence}`;
	let timer: number | undefined;
	let unlisten: UnlistenFn | undefined;
	let resolveResponse: ((value: PiRpcResponse<T>) => void) | undefined;
	let rejectResponse: ((reason?: unknown) => void) | undefined;
	const response = new Promise<PiRpcResponse<T>>((resolve, reject) => {
		resolveResponse = resolve;
		rejectResponse = reject;
	});

	try {
		unlisten = await listenRuntimeEvents(
			(event) => {
				if (event.type !== "rpc_message" || !isRecord(event.message)) return;
				if (event.message.type !== "response" || event.message.id !== id)
					return;
				resolveResponse?.(event.message as PiRpcResponse<T>);
			},
			{ sessionKey },
		);
		timer = window.setTimeout(
			() => rejectResponse?.(new Error("Pi RPC 请求超时。")),
			timeoutMs,
		);
		await invoke(sessionKey ? "chat_session_send_rpc" : "runtime_send_rpc", {
			sessionKey,
			command: { ...command, id },
		});
		const result = await response;
		if (!result.success) {
			throw new Error(result.error || `Pi RPC ${result.command} 执行失败。`);
		}
		return result.data as T;
	} finally {
		if (timer !== undefined) window.clearTimeout(timer);
		unlisten?.();
	}
}

export function getPiState(): Promise<PiSessionSnapshot> {
	return invoke<PiSessionSnapshot>("runtime_get_pi_state");
}

export function switchPiSession(
	sessionPath: string,
): Promise<{ cancelled: boolean }> {
	return requestPiRpc({ type: "switch_session", sessionPath });
}

export function startNewPiSession(): Promise<{ cancelled: boolean }> {
	return requestPiRpc({ type: "new_session" });
}

export function getPiMessages(): Promise<{ messages: unknown[] }> {
	return requestPiRpc({ type: "get_messages" });
}

export function getPiAgentState(): Promise<PiAgentState> {
	return requestPiRpc({ type: "get_state" });
}

export function getAvailablePiModels(): Promise<{ models: PiModel[] }> {
	return requestPiRpc({ type: "get_available_models" });
}

export function setPiModel(
	model: Pick<PiModel, "id" | "provider">,
): Promise<PiModel> {
	return requestPiRpc({
		type: "set_model",
		provider: model.provider,
		modelId: model.id,
	});
}

export function cyclePiModel(): Promise<PiModelCycleResult | null> {
	return requestPiRpc({ type: "cycle_model" });
}

export function getAvailablePiThinkingLevels(): Promise<{
	levels: PiThinkingLevel[];
}> {
	return requestPiRpc({ type: "get_available_thinking_levels" });
}

export function setPiThinkingLevel(level: PiThinkingLevel): Promise<void> {
	return requestPiRpc({
		type: "set_thinking_level",
		level,
	});
}

export function setPiSessionName(name: string): Promise<void> {
	return requestPiRpc({
		type: "set_session_name",
		name,
	});
}

export type PiSessionStats = {
	userMessages?: number;
	assistantMessages?: number;
	toolCalls?: number;
	toolResults?: number;
	totalMessages?: number;
	tokens?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total?: number;
	};
	cost?: number;
	contextUsage?: {
		tokens?: number | null;
		contextWindow?: number;
		percent?: number | null;
	};
};

export function getPiSessionStats(): Promise<PiSessionStats> {
	return requestPiRpc({ type: "get_session_stats" });
}

export function listWslDistributions(): Promise<WslDistribution[]> {
	return invoke<WslDistribution[]>("wsl_list_distributions");
}

export function restartPi(): Promise<PiSessionSnapshot> {
	return invoke<PiSessionSnapshot>("runtime_restart_pi");
}

export function sendPiPrompt(message: string): Promise<void> {
	return invoke("runtime_send_rpc", {
		command: {
			type: "prompt",
			message,
		},
	});
}

export function sendPiFollowUp(message: string): Promise<void> {
	return requestPiRpc<void>({
		type: "follow_up",
		message,
	});
}

export function sendPiSteer(message: string): Promise<void> {
	return requestPiRpc<void>({
		type: "steer",
		message,
	});
}

export function abortPiReply(): Promise<void> {
	return invoke("runtime_abort_pi");
}

export function runtimeErrorMessage(error: unknown): string {
	if (typeof error === "string" && error.trim()) return error;
	if (error instanceof Error && error.message.trim()) return error.message;
	if (error && typeof error === "object") {
		const message = Reflect.get(error, "message");
		if (typeof message === "string" && message.trim()) return message;
	}
	return "Pi Runtime 请求失败";
}
