import { invoke } from "@tauri-apps/api/core";

const CHAT_PERF_STORAGE_KEY = "pilo.debug.chatPerformance";
const REPORT_INTERVAL_MS = 1_000;
const SCROLL_ACTIVE_MS = 180;
let debugEnabled: boolean | undefined;

type Counters = {
	runtimeEvents: number;
	presentationFlushes: number;
	presentationInputActions: number;
	presentationCoalescedActions: number;
	backgroundPresentationFlushes: number;
	chatRenders: number;
	userMessageRenders: number;
	assistantMessageRenders: number;
	markdownRenders: number;
	markdownChars: number;
	markdownParses: number;
	markdownParsedChars: number;
	markdownReusedChars: number;
	markdownFullParses: number;
	markdownFootnoteFallbacks: number;
	markdownReferenceFallbacks: number;
	markdownParseMs: number;
	markdownMaxLiveTailChars: number;
	virtualChanges: number;
	virtualSyncChanges: number;
	virtualRangeChanges: number;
	scrollEvents: number;
	scrollFrames: number;
	slowScrollFrames: number;
	verySlowScrollFrames: number;
	longTasks: number;
	longTaskMs: number;
	historyWindowLoads: number;
	historyWindowMs: number;
	historyWindowMessages: number;
	stickyContentResizes: number;
	stickyViewportResizes: number;
	stickyFollowRequests: number;
	stickyFollowFrames: number;
	stickyVirtuaScrollCalls: number;
	stickyDomScrollWrites: number;
};

type ChatPerfContext = {
	sessionId: string;
	activePresentationIntervalMs: number | null;
	messageCount: number;
	virtualized: boolean;
	visibleStart: number | null;
	visibleEnd: number | null;
	virtualTotalSize: number | null;
	domNodes: number | null;
	historyDirectoryMessages: number;
	historyHydratedMessages: number;
	lastSwitchFrom: string | null;
	lastSwitchTo: string | null;
	lastSwitchMs: number | null;
};

export type ChatPerformanceReport = ChatPerfContext &
	Counters & {
		timestamp: string;
		intervalMs: number;
		avgMarkdownChars: number;
		jsHeapUsedMb: number | null;
		jsHeapTotalMb: number | null;
	};

type PendingSwitch = {
	fromSessionId: string | null;
	toSessionId: string;
	startedAt: number;
};

type ChatPerfState = {
	counters: Counters;
	context: ChatPerfContext;
	lastReportAt: number;
	lastScrollFrameAt: number | null;
	scrollActiveUntil: number;
	lastVirtualRange: string;
	observer: PerformanceObserver | null;
	pendingSwitch: PendingSwitch | null;
	lastReport: ChatPerformanceReport | null;
	listeners: Set<() => void>;
};

const EMPTY_COUNTERS = (): Counters => ({
	runtimeEvents: 0,
	presentationFlushes: 0,
	presentationInputActions: 0,
	presentationCoalescedActions: 0,
	backgroundPresentationFlushes: 0,
	chatRenders: 0,
	userMessageRenders: 0,
	assistantMessageRenders: 0,
	markdownRenders: 0,
	markdownChars: 0,
	markdownParses: 0,
	markdownParsedChars: 0,
	markdownReusedChars: 0,
	markdownFullParses: 0,
	markdownFootnoteFallbacks: 0,
	markdownReferenceFallbacks: 0,
	markdownParseMs: 0,
	markdownMaxLiveTailChars: 0,
	virtualChanges: 0,
	virtualSyncChanges: 0,
	virtualRangeChanges: 0,
	scrollEvents: 0,
	scrollFrames: 0,
	slowScrollFrames: 0,
	verySlowScrollFrames: 0,
	longTasks: 0,
	longTaskMs: 0,
	historyWindowLoads: 0,
	historyWindowMs: 0,
	historyWindowMessages: 0,
	stickyContentResizes: 0,
	stickyViewportResizes: 0,
	stickyFollowRequests: 0,
	stickyFollowFrames: 0,
	stickyVirtuaScrollCalls: 0,
	stickyDomScrollWrites: 0,
});

const state: ChatPerfState = {
	counters: EMPTY_COUNTERS(),
	context: {
		sessionId: "",
		activePresentationIntervalMs: null,
		messageCount: 0,
		virtualized: false,
		visibleStart: null,
		visibleEnd: null,
		virtualTotalSize: null,
		domNodes: null,
		historyDirectoryMessages: 0,
		historyHydratedMessages: 0,
		lastSwitchFrom: null,
		lastSwitchTo: null,
		lastSwitchMs: null,
	},
	lastReportAt: 0,
	lastScrollFrameAt: null,
	scrollActiveUntil: 0,
	lastVirtualRange: "",
	observer: null,
	pendingSwitch: null,
	lastReport: null,
	listeners: new Set(),
};

export function isChatPerformanceDebugEnabled() {
	if (typeof window === "undefined") return false;
	if (import.meta.env.DEV) return true;
	debugEnabled ??= window.localStorage.getItem(CHAT_PERF_STORAGE_KEY) === "1";
	return debugEnabled;
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

function heapSnapshot() {
	const memory = (
		performance as Performance & {
			memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
		}
	).memory;
	if (!memory) return { used: null, total: null };
	return {
		used: Math.round((memory.usedJSHeapSize / 1024 / 1024) * 10) / 10,
		total: Math.round((memory.totalJSHeapSize / 1024 / 1024) * 10) / 10,
	};
}

function emitReport(report: ChatPerformanceReport) {
	state.lastReport = report;
	for (const listener of state.listeners) listener();
}

function maybeReport(now = performance.now(), force = false) {
	if (!isChatPerformanceDebugEnabled()) return;
	ensureLongTaskObserver();
	if (!force && now - state.lastReportAt < REPORT_INTERVAL_MS) return;
	const intervalMs =
		state.lastReportAt === 0 ? REPORT_INTERVAL_MS : now - state.lastReportAt;
	state.lastReportAt = now;
	state.context.domNodes = document.querySelectorAll("*").length;
	const counters = state.counters;
	const avgMarkdownChars = counters.markdownRenders
		? Math.round(counters.markdownChars / counters.markdownRenders)
		: 0;
	const heap = heapSnapshot();
	const report: ChatPerformanceReport = {
		timestamp: new Date().toISOString(),
		intervalMs: Math.round(intervalMs),
		...state.context,
		...counters,
		longTaskMs: Math.round(counters.longTaskMs),
		markdownParseMs: Math.round(counters.markdownParseMs * 10) / 10,
		historyWindowMs: Math.round(counters.historyWindowMs),
		avgMarkdownChars,
		jsHeapUsedMb: heap.used,
		jsHeapTotalMb: heap.total,
	};
	console.info("[Pilo perf] chat", report);
	if (import.meta.env.DEV) {
		void invoke("debug_chat_performance_log", {
			payload: JSON.stringify(report),
		}).catch(() => undefined);
	}
	emitReport(report);
	state.counters = EMPTY_COUNTERS();
}

export function subscribeChatPerformanceReport(listener: () => void) {
	state.listeners.add(listener);
	return () => state.listeners.delete(listener);
}

export function getChatPerformanceReport() {
	return state.lastReport;
}

export function sampleChatPerformanceNow() {
	if (!isChatPerformanceDebugEnabled()) return;
	maybeReport(performance.now(), true);
}

export function recordChatSessionSwitchStart(
	fromSessionId: string | null,
	toSessionId: string,
) {
	if (!isChatPerformanceDebugEnabled() || fromSessionId === toSessionId) return;
	if (import.meta.env.DEV) {
		void invoke("debug_chat_performance_log", {
			payload: JSON.stringify({
				timestamp: new Date().toISOString(),
				type: "switch_start",
				fromSessionId,
				toSessionId,
			}),
		}).catch(() => undefined);
	}
	state.pendingSwitch = {
		fromSessionId,
		toSessionId,
		startedAt: performance.now(),
	};
}

export function recordChatSessionSwitchReady(sessionId: string) {
	if (!isChatPerformanceDebugEnabled()) return;
	const pending = state.pendingSwitch;
	if (import.meta.env.DEV) {
		void invoke("debug_chat_performance_log", {
			payload: JSON.stringify({
				timestamp: new Date().toISOString(),
				type: "switch_ready",
				readySessionId: sessionId,
				requestedSessionId: pending?.toSessionId ?? null,
			}),
		}).catch(() => undefined);
	}
	if (!pending) return;
	if (import.meta.env.DEV && pending.toSessionId !== sessionId) {
		void invoke("debug_chat_performance_log", {
			payload: JSON.stringify({
				timestamp: new Date().toISOString(),
				type: "switch_id_mismatch",
				requestedSessionId: pending.toSessionId,
				readySessionId: sessionId,
			}),
		}).catch(() => undefined);
	}
	// Only the active viewport reports ready, so its first ready layout after a
	// selection is the switch completion even when a draft controller was
	// re-keyed to the Pi session id between selection and layout.
	state.pendingSwitch = null;
	state.context.lastSwitchFrom = pending.fromSessionId;
	state.context.lastSwitchTo = sessionId;
	state.context.lastSwitchMs =
		Math.round((performance.now() - pending.startedAt) * 10) / 10;
	maybeReport(performance.now(), true);
}

export function recordHistoryWindowLoad({
	durationMs,
	messageCount,
	directoryMessages,
	hydratedMessages,
}: {
	durationMs: number;
	messageCount: number;
	directoryMessages: number;
	hydratedMessages: number;
}) {
	if (!isChatPerformanceDebugEnabled()) return;
	state.counters.historyWindowLoads += 1;
	state.counters.historyWindowMs += durationMs;
	state.counters.historyWindowMessages += messageCount;
	state.context.historyDirectoryMessages = directoryMessages;
	state.context.historyHydratedMessages = hydratedMessages;
	maybeReport();
}

export function recordHistoryHydration(
	directoryMessages: number,
	hydratedMessages: number,
) {
	if (!isChatPerformanceDebugEnabled()) return;
	state.context.historyDirectoryMessages = directoryMessages;
	state.context.historyHydratedMessages = hydratedMessages;
	maybeReport();
}

export function recordChatRuntimeEvent() {
	if (!isChatPerformanceDebugEnabled()) return;
	state.counters.runtimeEvents += 1;
}

export function recordChatPresentationInterval(intervalMs: number) {
	if (!isChatPerformanceDebugEnabled()) return;
	state.context.activePresentationIntervalMs = intervalMs;
}

export function recordChatPresentationFlush({
	active,
	inputActions,
	coalescedActions,
}: {
	active: boolean;
	inputActions: number;
	coalescedActions: number;
}) {
	if (!isChatPerformanceDebugEnabled()) return;
	state.counters.presentationFlushes += 1;
	state.counters.presentationInputActions += inputActions;
	state.counters.presentationCoalescedActions += coalescedActions;
	if (!active) state.counters.backgroundPresentationFlushes += 1;
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
}

export function recordChatMessageRender(role: "user" | "assistant") {
	if (!isChatPerformanceDebugEnabled()) return;
	if (role === "user") state.counters.userMessageRenders += 1;
	else state.counters.assistantMessageRenders += 1;
}

export function recordMarkdownRender(charCount: number) {
	if (!isChatPerformanceDebugEnabled()) return;
	state.counters.markdownRenders += 1;
	state.counters.markdownChars += charCount;
}

export function recordMarkdownParse({
	parsedChars,
	reusedChars,
	liveTailChars,
	fullParse,
	footnoteFallback,
	referenceFallback,
	durationMs,
}: {
	parsedChars: number;
	reusedChars: number;
	liveTailChars: number;
	fullParse: boolean;
	footnoteFallback: boolean;
	referenceFallback: boolean;
	durationMs: number;
}) {
	if (!isChatPerformanceDebugEnabled()) return;
	state.counters.markdownParses += 1;
	state.counters.markdownParsedChars += parsedChars;
	state.counters.markdownReusedChars += reusedChars;
	state.counters.markdownParseMs += durationMs;
	state.counters.markdownMaxLiveTailChars = Math.max(
		state.counters.markdownMaxLiveTailChars,
		liveTailChars,
	);
	if (fullParse) state.counters.markdownFullParses += 1;
	if (footnoteFallback) state.counters.markdownFootnoteFallbacks += 1;
	if (referenceFallback) state.counters.markdownReferenceFallbacks += 1;
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
}

export function recordStickyScrollMetric(
	metric:
		| "content-resize"
		| "viewport-resize"
		| "follow-request"
		| "follow-frame"
		| "virtua-scroll"
		| "dom-scroll-write",
) {
	if (!isChatPerformanceDebugEnabled()) return;
	switch (metric) {
		case "content-resize":
			state.counters.stickyContentResizes += 1;
			break;
		case "viewport-resize":
			state.counters.stickyViewportResizes += 1;
			break;
		case "follow-request":
			state.counters.stickyFollowRequests += 1;
			break;
		case "follow-frame":
			state.counters.stickyFollowFrames += 1;
			break;
		case "virtua-scroll":
			state.counters.stickyVirtuaScrollCalls += 1;
			break;
		case "dom-scroll-write":
			state.counters.stickyDomScrollWrites += 1;
			break;
	}
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
	if (now < state.scrollActiveUntil) requestAnimationFrame(sampleScrollFrame);
	else state.lastScrollFrameAt = null;
}

export function logChatPerformanceInstructions() {
	if (import.meta.env.DEV) {
		console.info(
			"[Pilo perf] dev monitoring enabled; JSONL: /tmp/pilo-chat-performance.jsonl",
		);
		return;
	}
	console.info(
		"[Pilo perf] enable with localStorage.setItem('pilo.debug.chatPerformance','1'); location.reload(); disable with localStorage.removeItem('pilo.debug.chatPerformance'); location.reload();",
	);
}
