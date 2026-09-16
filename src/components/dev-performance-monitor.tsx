import { useEffect, useState, useSyncExternalStore } from "react";

import {
	getChatPerformanceReport,
	sampleChatPerformanceNow,
	subscribeChatPerformanceReport,
} from "@/lib/chat-performance";
import { cn } from "@/lib/utils";

function compactNumber(value: number | null) {
	if (value === null) return "-";
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

function metricRate(value: number, intervalMs: number) {
	if (intervalMs <= 0) return value.toFixed(1);
	return ((value * 1_000) / intervalMs).toFixed(1);
}

export function DevPerformanceMonitor() {
	const report = useSyncExternalStore(
		subscribeChatPerformanceReport,
		getChatPerformanceReport,
		getChatPerformanceReport,
	);
	const [collapsed, setCollapsed] = useState(false);

	useEffect(() => {
		sampleChatPerformanceNow();
		const timer = window.setInterval(sampleChatPerformanceNow, 1_000);
		return () => window.clearInterval(timer);
	}, []);

	return (
		<div className="fixed bottom-3 right-3 z-[10000] select-none font-mono text-[10px] leading-4 text-foreground">
			<button
				type="button"
				className={cn(
					"rounded-md border border-border/80 bg-background/95 px-2 py-1 shadow-lg backdrop-blur",
					!collapsed && "mb-1",
				)}
				onClick={() => setCollapsed((value) => !value)}
			>
				PERF {report?.lastSwitchMs != null ? `${report.lastSwitchMs}ms` : "DEV"}
			</button>
			{!collapsed ? (
				<div className="w-[360px] rounded-md border border-border/80 bg-background/95 p-2 shadow-xl backdrop-blur">
					<div className="grid grid-cols-[88px_1fr] gap-x-2 gap-y-0.5 tabular-nums">
						<span className="text-muted-foreground">session</span>
						<span className="truncate">{report?.sessionId || "-"}</span>
						<span className="text-muted-foreground">switch</span>
						<span>
							{report?.lastSwitchMs != null ? `${report.lastSwitchMs} ms` : "-"}
						</span>
						<span className="text-muted-foreground">runtime</span>
						<span>
							{report
								? metricRate(report.runtimeEvents, report.intervalMs)
								: "-"}
							ev/s
						</span>
						<span className="text-muted-foreground">present</span>
						<span>
							{report
								? `${report.presentationFlushes} · ${report.presentationInputActions}/${report.presentationCoalescedActions} · bg ${report.backgroundPresentationFlushes} · ${report.activePresentationIntervalMs ?? "-"} ms`
								: "-"}
						</span>
						<span className="text-muted-foreground">chat render</span>
						<span>
							{report ? metricRate(report.chatRenders, report.intervalMs) : "-"}
							/s
						</span>
						<span className="text-muted-foreground">message</span>
						<span>
							{report
								? `${report.userMessageRenders}/${report.assistantMessageRenders}`
								: "-"}
						</span>
						<span className="text-muted-foreground">markdown</span>
						<span>
							{report
								? `${report.markdownRenders} · ${compactNumber(report.markdownChars)} chars`
								: "-"}
						</span>
						<span className="text-muted-foreground">md parse</span>
						<span>
							{report
								? `${report.markdownParses} · ${compactNumber(report.markdownParsedChars)}/${compactNumber(report.markdownReusedChars)} · tail ${compactNumber(report.markdownMaxLiveTailChars)} · ${report.markdownParseMs} ms`
								: "-"}
						</span>
						<span className="text-muted-foreground">virtua</span>
						<span>
							{report
								? `${report.virtualChanges} · ${report.visibleStart ?? "-"}-${report.visibleEnd ?? "-"}`
								: "-"}
						</span>
						<span className="text-muted-foreground">sticky</span>
						<span>
							{report
								? `${report.stickyContentResizes}/${report.stickyFollowFrames}/${report.stickyDomScrollWrites} · v ${report.stickyVirtuaScrollCalls}`
								: "-"}
						</span>
						<span className="text-muted-foreground">scroll</span>
						<span>
							{report
								? `${report.scrollEvents} · slow ${report.slowScrollFrames}/${report.verySlowScrollFrames}`
								: "-"}
						</span>
						<span className="text-muted-foreground">long task</span>
						<span>
							{report ? `${report.longTasks} · ${report.longTaskMs} ms` : "-"}
						</span>
						<span className="text-muted-foreground">history</span>
						<span>
							{report
								? `${report.historyHydratedMessages}/${report.historyDirectoryMessages} · ${report.historyWindowLoads} req · ${report.historyWindowMs} ms`
								: "-"}
						</span>
						<span className="text-muted-foreground">DOM</span>
						<span>{compactNumber(report?.domNodes ?? null)} nodes</span>
						<span className="text-muted-foreground">JS heap</span>
						<span>
							{report?.jsHeapUsedMb != null
								? `${report.jsHeapUsedMb}/${report.jsHeapTotalMb} MB`
								: "n/a (WebKit)"}
						</span>
					</div>
				</div>
			) : null}
		</div>
	);
}
