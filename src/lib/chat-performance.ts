import { invoke } from "@tauri-apps/api/core";

const CHAT_PERF_STORAGE_KEY = "pilo.debug.chatPerformance";
const REPORT_INTERVAL_MS = 1_000;
const SCROLL_ACTIVE_MS = 180;

type Counters = {
	chatRenders: number;
	userMessageRenders: number;
	assistantMessageRenders: number;
	markdownRenders: number;
	markdownChars: number;
	virtualChanges: number;
	virtualSyncChanges: number;
	virtualRangeChanges: number;
	scrollEvents: number;
	scrollFrames: number;
	slowScrollFrames: number;
	verySlowScrollFrames: number;
	longTasks: number;
	longTaskMs: number;
};

type ChatPerfContext = {
	sessionId: string;
	messageCount: number;
	virtualized: boolean;
	visibleStart: number | null;
	visibleEnd: number | null;
	virtualTotalSize: number | null;
	domNodes: number | null;
};

type ChatPerfState = {
	counters: Counters;
	context: ChatPerfContext;
	lastReportAt: number;
	lastScrollFrameAt: number | null;
	scrollActiveUntil: number;
	lastVirtualRange: string;
	observer: PerformanceObserver | null;
};

const EMPTY_COUNTERS = (): Counters => ({
	chatRenders: 0,
	userMessageRenders: 0,
	assistantMessageRenders: 0,
	markdownRenders: 0,
	markdownChars: 0,
	virtualChanges: 0,
	virtualSyncChanges: 0,
	virtualRangeChanges: 0,
	scrollEvents: 0,
	scrollFrames: 0,
	slowScrollFrames: 0,
	verySlowScrollFrames: 0,
	longTasks: 0,
	longTaskMs: 0,
});

const state: ChatPerfState = {
	counters: EMPTY_COUNTERS(),
	context: {
		sessionId: "",
		messageCount: 0,
		virtualized: false,
		visibleStart: null,
		visibleEnd: null,
		virtualTotalSize: null,
		domNodes: null,
	},
	lastReportAt: 0,
	lastScrollFrameAt: null,
	scrollActiveUntil: 0,
	lastVirtualRange: "",
	observer: null,
};

export function isChatPerformanceDebugEnabled() {
	if (typeof window === "undefined") return false;
	return (
		import.meta.env.DEV ||
		window.localStorage.getItem(CHAT_PERF_STORAGE_KEY) === "1"
	);
}

function ensureLongTaskObserver() {
	if (!isChatPerformanceDebugEnabled() || state.observer) return;
	if (typeof PerformanceObserver === "undefined") return;
	try {
		const supported = PerformanceObserver.supportedEntryTypes ?? [];
		if (!supported.includes("longtask")) return;
		state.observer = new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				state.counters.longTasks += 1;
				state.counters.longTaskMs += entry.duration;
			}
		});
		state.observer.observe({ entryTypes: ["longtask"] });
	} catch {
		state.observer = null;
	}
}

function maybeReport(now = performance.now()) {
	if (!isChatPerformanceDebugEnabled()) return;
	ensureLongTaskObserver();
	if (now - state.lastReportAt < REPORT_INTERVAL_MS) return;
	state.lastReportAt = now;
	state.context.domNodes = document.querySelectorAll("*").length;
	const counters = state.counters;
	const avgMarkdownChars = counters.markdownRenders
		? Math.round(counters.markdownChars / counters.markdownRenders)
		: 0;
	const report = {
		timestamp: new Date().toISOString(),
		...state.context,
		...counters,
		avgMarkdownChars,
	};
	console.info("[Pilo perf] chat", report);
	void invoke("debug_chat_performance_log", {
		payload: JSON.stringify(report),
	}).catch(() => undefined);
	state.counters = EMPTY_COUNTERS();
}

export function recordChatPageRender(
	sessionId: string,
	messageCount: number,
	virtualized: boolean,
) {
	if (!isChatPerformanceDebugEnabled()) return;
	state.context.sessionId = sessionId;
	state.context.messageCount = messageCount;
	state.context.virtualized = virtualized;
	state.counters.chatRenders += 1;
	maybeReport();
}

export function recordChatMessageRender(role: "user" | "assistant") {
	if (!isChatPerformanceDebugEnabled()) return;
	if (role === "user") state.counters.userMessageRenders += 1;
	else state.counters.assistantMessageRenders += 1;
	maybeReport();
}

export function recordMarkdownRender(charCount: number) {
	if (!isChatPerformanceDebugEnabled()) return;
	state.counters.markdownRenders += 1;
	state.counters.markdownChars += charCount;
	maybeReport();
}

export function recordVirtualChange({
	sync,
	startIndex,
	endIndex,
	totalSize,
}: {
	sync: boolean;
	startIndex: number | null;
	endIndex: number | null;
	totalSize: number;
}) {
	if (!isChatPerformanceDebugEnabled()) return;
	state.counters.virtualChanges += 1;
	if (sync) state.counters.virtualSyncChanges += 1;
	const rangeKey = `${startIndex ?? "-"}:${endIndex ?? "-"}`;
	if (rangeKey !== state.lastVirtualRange) {
		state.lastVirtualRange = rangeKey;
		state.counters.virtualRangeChanges += 1;
	}
	state.context.visibleStart = startIndex;
	state.context.visibleEnd = endIndex;
	state.context.virtualTotalSize = Math.round(totalSize);
	maybeReport();
}

export function recordScrollEvent() {
	if (!isChatPerformanceDebugEnabled()) return;
	const now = performance.now();
	state.counters.scrollEvents += 1;
	state.scrollActiveUntil = now + SCROLL_ACTIVE_MS;
	if (state.lastScrollFrameAt === null) {
		state.lastScrollFrameAt = now;
		requestAnimationFrame(sampleScrollFrame);
	}
	maybeReport(now);
}

function sampleScrollFrame(now: number) {
	if (!isChatPerformanceDebugEnabled()) {
		state.lastScrollFrameAt = null;
		return;
	}
	const previous = state.lastScrollFrameAt;
	if (previous !== null) {
		const delta = now - previous;
		state.counters.scrollFrames += 1;
		if (delta >= 25) state.counters.slowScrollFrames += 1;
		if (delta >= 50) state.counters.verySlowScrollFrames += 1;
	}
	state.lastScrollFrameAt = now;
	maybeReport(now);
	if (now < state.scrollActiveUntil) requestAnimationFrame(sampleScrollFrame);
	else state.lastScrollFrameAt = null;
}

export function logChatPerformanceInstructions() {
	console.info(
		"[Pilo perf] enable with localStorage.setItem('pilo.debug.chatPerformance','1'); location.reload(); disable with localStorage.removeItem('pilo.debug.chatPerformance'); location.reload();",
	);
}
