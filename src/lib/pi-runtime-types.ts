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

/** Pi 进程运行位置：远程主机（默认）或本地本机。 */
export type PiRuntime = "workspace" | "local";

export type Connection = {
	id: string;
	name: string;
	piExecutable?: string | null;
	piRuntime?: PiRuntime;
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
	/** Thinking level Pi applies when this model is selected through the scoped-model cycle. */
	scopeThinkingLevel?: PiThinkingLevel | null;
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
	autoCompactionEnabled?: boolean;
};

export type PiCommand = {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
	sourceInfo: {
		path: string;
		source: string;
		scope: "user" | "project" | "temporary";
		origin: "package" | "top-level";
		baseDir?: string;
	};
};

export type PiCompactionResult = {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	estimatedTokensAfter: number;
};

export type PiSessionEntry = {
	id: string;
	parentId: string | null;
	type: string;
	message?: {
		role?: string;
	};
};

export type PiSessionEntries = {
	entries: PiSessionEntry[];
	leafId: string | null;
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
	| { type: "compaction_start"; generation: number; reason: string }
	| {
			type: "compaction_end";
			generation: number;
			reason: string;
			result: PiCompactionResult | null;
			aborted: boolean;
			willRetry: boolean;
			errorMessage: string | null;
	  }
	| {
			type: "auto_retry_start";
			generation: number;
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| {
			type: "auto_retry_end";
			generation: number;
			success: boolean;
			attempt: number;
			finalError: string | null;
	  }
	| {
			type: "summarization_retry_scheduled";
			generation: number;
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| {
			type: "summarization_retry_attempt_start";
			generation: number;
			source: string;
			reason: string | null;
	  }
	| { type: "summarization_retry_finished"; generation: number }
	| {
			type: "extension_ui_request";
			generation: number;
			id: string;
			method: string;
			title: string | null;
			message: string | null;
			options: string[];
			placeholder: string | null;
			prefill: string | null;
			timeout: number | null;
			notifyType: "info" | "warning" | "error" | null;
			statusKey: string | null;
			statusText: string | null;
			widgetKey: string | null;
			widgetLines: string[] | null;
			widgetPlacement: string | null;
			text: string | null;
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
