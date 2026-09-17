import {
	clearChatSessionSwitchSamples,
	getChatPerformanceReport,
	getChatSessionSwitchSamples,
	sampleChatPerformanceNow,
} from "@/lib/chat-performance";
import { summarizeChatSessionSwitchSamples } from "@/lib/chat-performance-switch";

type ChatPerformanceDebugApi = {
	report: typeof getChatPerformanceReport;
	sample: typeof sampleChatPerformanceNow;
	switches: typeof getChatSessionSwitchSamples;
	clearSwitches: typeof clearChatSessionSwitchSamples;
	switchSummary: () => ReturnType<typeof summarizeChatSessionSwitchSamples>;
};

declare global {
	interface Window {
		__PILO_CHAT_PERFORMANCE__?: ChatPerformanceDebugApi;
	}
}

export function installChatPerformanceDebugApi() {
	if (!import.meta.env.DEV) return;
	window["__PILO_CHAT_PERFORMANCE__"] = {
		report: getChatPerformanceReport,
		sample: sampleChatPerformanceNow,
		switches: getChatSessionSwitchSamples,
		clearSwitches: clearChatSessionSwitchSamples,
		switchSummary() {
			return summarizeChatSessionSwitchSamples(getChatSessionSwitchSamples());
		},
	};
}
