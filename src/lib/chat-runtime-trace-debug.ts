import {
	listChatRuntimeReplayTargets,
	replayChatRuntimeTraceToUi,
	type ChatRuntimeReplayOptions,
	type ChatRuntimeReplayTargetInfo,
} from "@/lib/chat-runtime-replay";
import {
	clearChatRuntimeTraceRecording,
	getChatRuntimeTraceRecording,
	isChatRuntimeTraceRecording,
	parseChatRuntimeTrace,
	serializeChatRuntimeTrace,
	startChatRuntimeTraceRecording,
	stopChatRuntimeTraceRecording,
	type ChatRuntimeTraceEntry,
} from "@/lib/chat-runtime-trace";

type ChatRuntimeTraceDebugApi = {
	start: () => void;
	stop: () => ChatRuntimeTraceEntry[];
	clear: () => void;
	status: () => { recording: boolean; entries: number };
	exportJsonl: () => string;
	parse: (source: string) => ChatRuntimeTraceEntry[];
	targets: () => ChatRuntimeReplayTargetInfo[];
	replay: (
		source: string | readonly ChatRuntimeTraceEntry[],
		options?: ChatRuntimeReplayOptions,
	) => Promise<void>;
};

declare global {
	interface Window {
		__PILO_CHAT_RUNTIME_TRACE__?: ChatRuntimeTraceDebugApi;
	}
}

export function installChatRuntimeTraceDebugApi() {
	if (!import.meta.env.DEV) return;
	window["__PILO_CHAT_RUNTIME_TRACE__"] = {
		start() {
			startChatRuntimeTraceRecording();
		},
		stop() {
			return stopChatRuntimeTraceRecording();
		},
		clear() {
			clearChatRuntimeTraceRecording();
		},
		status() {
			return {
				recording: isChatRuntimeTraceRecording(),
				entries: getChatRuntimeTraceRecording().length,
			};
		},
		exportJsonl() {
			return serializeChatRuntimeTrace(getChatRuntimeTraceRecording());
		},
		parse(source) {
			return parseChatRuntimeTrace(source);
		},
		targets() {
			return listChatRuntimeReplayTargets();
		},
		replay(source, options) {
			const entries =
				typeof source === "string" ? parseChatRuntimeTrace(source) : source;
			return replayChatRuntimeTraceToUi(entries, options);
		},
	};
}
