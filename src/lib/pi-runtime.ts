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

export type SshTarget =
	| { type: "config_host"; host: string }
	| {
			type: "direct";
			hostname: string;
			port: number | null;
			user: string | null;
			identityFile: string | null;
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
	workspaceId: string | null;
};

type LocalStartPiResponse = {
	session: PiSessionSnapshot;
};

export type WslDistribution = {
	name: string;
};

export type WslConnection = {
	id: string;
	name: string;
	distro: string;
};

export type WslEnvironmentInfo = {
	cwd: string;
	gitBranch: string | null;
	piExecutable: string;
	piVersion: string;
	nodeExecutable: string;
	nodeVersion: string;
	gitExecutable: string;
	gitVersion: string;
};

export type WslConnectionProbe = {
	connection: WslConnection;
	environment: WslEnvironmentInfo;
};

type WslStartPiResponse = {
	connection: WslConnection;
	environment: WslEnvironmentInfo;
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
		unlisten = await listenRuntimeEvents((event) => {
			if (event.type !== "rpc_message" || !isRecord(event.message)) return;
			if (event.message.type !== "response" || event.message.id !== id) return;
			resolveResponse?.(event.message as PiRpcResponse<T>);
		});
		timer = window.setTimeout(
			() => rejectResponse?.(new Error("Pi RPC 请求超时。")),
			timeoutMs,
		);
		await invoke("runtime_send_rpc", { command: { ...command, id } });
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

export function listWslDistributions(): Promise<WslDistribution[]> {
	return invoke<WslDistribution[]>("wsl_list_distributions");
}

export function probeWslConnection(
	distro: string,
	workspace: string,
): Promise<WslConnectionProbe> {
	return invoke<WslConnectionProbe>("wsl_probe_connection", {
		distro,
		workspace,
	});
}

export async function ensureWslPi(
	distro: string,
	workspace: string,
): Promise<PiSessionSnapshot> {
	const current = await invoke<PiSessionSnapshot>("runtime_get_pi_state");
	if (current.state === "running") {
		if (
			current.connection?.kind.type !== "wsl" ||
			current.connection.kind.distro !== distro
		) {
			throw new Error(
				`Pi Runtime 当前连接到 ${current.connection?.name ?? "其他环境"}，无法复用为 WSL ${distro} 会话。`,
			);
		}
		return current;
	}

	if (current.state === "starting" || current.state === "stopping") {
		throw new Error(`Pi Runtime 当前处于 ${current.state} 状态，请稍后重试。`);
	}

	const started = await invoke<WslStartPiResponse>("wsl_start_pi", {
		distro,
		workspace,
	});
	return started.session;
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

export type SshEnvironmentInfo = {
	cwd: string;
	gitBranch: string | null;
	piExecutable: string;
	piVersion: string;
	nodeExecutable: string;
	nodeVersion: string;
	gitExecutable: string;
	gitVersion: string;
};

export type SshConnectionProbe = {
	connection: {
		id: string;
		name: string;
		target: SshTarget;
	};
	environment: SshEnvironmentInfo;
};

export type SshStartPiResponse = {
	connection: SshConnectionProbe["connection"];
	environment: SshEnvironmentInfo;
	session: PiSessionSnapshot;
};

export function probeSshConnection(
	target: SshTarget,
	workspace: string,
): Promise<SshConnectionProbe> {
	return invoke<SshConnectionProbe>("ssh_probe_connection", {
		target,
		workspace,
	});
}

export async function ensureSshPi(
	target: SshTarget,
	workspace: string,
): Promise<PiSessionSnapshot> {
	const current = await invoke<PiSessionSnapshot>("runtime_get_pi_state");
	if (current.state === "running") {
		if (current.connection?.kind.type !== "ssh") {
			throw new Error(
				`Pi Runtime 当前连接到 ${current.connection?.name ?? "其他环境"}，无法复用为 SSH 会话。`,
			);
		}
		return current;
	}

	const started = await invoke<SshStartPiResponse>("ssh_start_pi", {
		target,
		workspace,
	});
	return started.session;
}
