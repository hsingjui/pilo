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

type ConnectionKind =
	| { type: "local" }
	| { type: "wsl"; distro: string }
	| { type: "ssh"; host: string };

type Connection = {
	id: string;
	name: string;
	kind: ConnectionKind;
};

export type PiSessionSnapshot = {
	generation: number;
	state: PiProcessState;
	connection: Connection | null;
};

type LocalStartPiResponse = {
	session: PiSessionSnapshot;
};

export type PiloRuntimeEvent =
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
	  };

export function listenRuntimeEvents(
	handler: (event: PiloRuntimeEvent) => void,
): Promise<UnlistenFn> {
	return listen<PiloRuntimeEvent>(RUNTIME_EVENT_NAME, ({ payload }) => {
		handler(payload);
	});
}

export async function ensureLocalPi(
	workspace: string,
): Promise<PiSessionSnapshot> {
	const current = await invoke<PiSessionSnapshot>("runtime_get_pi_state");
	if (current.state === "running") {
		if (current.connection?.kind.type !== "local") {
			throw new Error(
				`Pi Runtime 当前连接到 ${current.connection?.name ?? "其他环境"}，无法复用为本地会话。`,
			);
		}
		return current;
	}

	if (current.state === "starting" || current.state === "stopping") {
		throw new Error(`Pi Runtime 当前处于 ${current.state} 状态，请稍后重试。`);
	}

	const started = await invoke<LocalStartPiResponse>("local_start_pi", {
		workspace,
	});
	return started.session;
}

export function sendPiPrompt(message: string): Promise<void> {
	return invoke("runtime_send_rpc", {
		command: {
			type: "prompt",
			message,
		},
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
