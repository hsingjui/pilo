import { CircleDashed } from "lucide-react";
import { memo, useState } from "react";

import type { ChatSessionRuntimeState } from "@/components/chat/chat-page-utils";
import { cn } from "@/lib/utils";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/ui";

const compactNumberFormatter = new Intl.NumberFormat("en", {
	notation: "compact",
});

const percentFormatter = new Intl.NumberFormat("en", {
	maximumFractionDigits: 1,
});

const RING_RADIUS = 10;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

type ComposerContextUsageProps = {
	usage?: ChatSessionRuntimeState | null;
	contextWindow?: number;
};

function finiteNumber(value: number | null | undefined) {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function formatCompactTokens(value: number | null | undefined) {
	const normalized = finiteNumber(value);
	return normalized === undefined
		? "—"
		: compactNumberFormatter.format(Math.max(0, normalized));
}

function formatPercent(value: number | null | undefined) {
	const normalized = finiteNumber(value);
	if (normalized === undefined) return "—";
	if (normalized >= 100) return "100%";
	return `${percentFormatter.format(Math.max(0, normalized))}%`;
}

function formatCost(value: number | undefined) {
	if (value === undefined || !Number.isFinite(value)) return "—";
	if (value < 0.01) return `$${value.toFixed(4)}`;
	return `$${value.toFixed(2)}`;
}

function ContextIcon({ percent }: { percent: number }) {
	const dashOffset = RING_CIRCUMFERENCE * (1 - percent / 100);

	return (
		<svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
			<circle
				cx="12"
				cy="12"
				r={RING_RADIUS}
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				className="opacity-25"
			/>
			<circle
				cx="12"
				cy="12"
				r={RING_RADIUS}
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeDasharray={RING_CIRCUMFERENCE}
				strokeDashoffset={dashOffset}
				className="-rotate-90 origin-center opacity-70"
			/>
		</svg>
	);
}

export const ComposerContextUsage = memo(function ComposerContextUsage({
	usage,
	contextWindow: modelContextWindow,
}: ComposerContextUsageProps) {
	const contextTokens = finiteNumber(usage?.contextTokens);
	const contextWindow =
		finiteNumber(usage?.contextWindow) ?? finiteNumber(modelContextWindow);
	const reportedPercent = finiteNumber(usage?.contextPercent);
	const contextStale = usage?.contextStale === true;
	const emptyContextPercent =
		!usage && contextWindow !== undefined && contextWindow > 0 ? 0 : undefined;
	const contextPercent =
		reportedPercent ??
		(contextTokens !== undefined &&
		contextWindow !== undefined &&
		contextWindow > 0
			? (contextTokens / contextWindow) * 100
			: emptyContextPercent);

	const tokens = usage?.tokens;
	const breakdownRows: Array<[string, number]> = (
		[
			["输入", finiteNumber(tokens?.input)],
			["输出", finiteNumber(tokens?.output)],
			["缓存读取", finiteNumber(tokens?.cacheRead)],
			["缓存写入", finiteNumber(tokens?.cacheWrite)],
		] as Array<[string, number | undefined]>
	).filter(
		(entry): entry is [string, number] =>
			entry[1] !== undefined && entry[1] > 0,
	);

	const ringPercent = Math.min(100, Math.max(0, contextPercent ?? 0));
	// HoverCard 只响应指针悬浮，这里受控补上键盘路径：focus-visible 打开，失焦关闭
	const [open, setOpen] = useState(false);
	const contextSummary =
		contextPercent === undefined
			? "上下文占用待更新"
			: contextStale
				? "上下文占用待更新（显示上次已知值）"
				: `上下文占用 ${formatPercent(contextPercent)}`;

	return (
		<HoverCard
			open={open}
			onOpenChange={setOpen}
			openDelay={0}
			closeDelay={150}
		>
			<HoverCardTrigger asChild>
				<button
					type="button"
					className={cn(
						"flex h-7 shrink-0 select-none items-center gap-1 rounded-md px-2 text-xs leading-tight text-muted-foreground transition-colors",
						"hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground",
						"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
						contextStale && "opacity-60",
					)}
					aria-label={contextSummary}
					aria-expanded={open}
					onFocus={(event) => {
						if (event.currentTarget.matches(":focus-visible")) setOpen(true);
					}}
					onBlur={() => setOpen(false)}
				>
					{contextPercent === undefined ? (
						<CircleDashed className="size-4" aria-hidden="true" />
					) : (
						<>
							<span className="font-medium tabular-nums leading-none">
								{formatPercent(contextPercent)}
							</span>
							<ContextIcon percent={ringPercent} />
						</>
					)}
				</button>
			</HoverCardTrigger>

			<HoverCardContent
				side="top"
				align="end"
				sideOffset={8}
				className="w-[248px] divide-y divide-border/60 overflow-hidden rounded-xl border-border/70 bg-background p-0 shadow-panel"
			>
				<div className="w-full space-y-2 px-2.5 py-2.5">
					<div className="flex items-center justify-between gap-3 text-xs">
						<p className="font-medium tabular-nums text-foreground">
							{formatPercent(contextPercent)}
						</p>
						<p className="font-mono text-[11px] tabular-nums text-muted-foreground">
							{formatCompactTokens(contextTokens)} /{" "}
							{formatCompactTokens(contextWindow)}
						</p>
					</div>
					<div className="relative h-1 w-full overflow-hidden rounded-full bg-muted">
						<div
							className="h-full rounded-full bg-foreground/70 transition-[width] duration-200"
							style={{ width: `${ringPercent}%` }}
						/>
					</div>
					{contextPercent === undefined ? (
						<p className="text-[11px] leading-4 text-muted-foreground">
							当前占用尚不可确定；首次回复或压缩后的下一次模型响应完成后会更新。
						</p>
					) : contextStale ? (
						<p className="text-[11px] leading-4 text-muted-foreground">
							压缩后占用待下一次模型响应更新，当前显示上一次已知值。
						</p>
					) : null}
				</div>

				{breakdownRows.length > 0 ? (
					<div className="w-full space-y-1.5 px-2.5 py-2">
						{breakdownRows.map(([label, value]) => (
							<div
								key={label}
								className="flex items-center justify-between text-xs"
							>
								<span className="text-muted-foreground">{label}</span>
								<span className="font-mono text-[11px] tabular-nums text-foreground">
									{formatCompactTokens(value)}
								</span>
							</div>
						))}
					</div>
				) : null}

				{usage?.cost !== undefined ? (
					<div className="flex w-full items-center justify-between gap-3 bg-muted/45 px-2.5 py-2 text-xs">
						<span className="text-muted-foreground">总费用</span>
						<span className="font-mono text-[11px] tabular-nums">
							{formatCost(usage.cost)}
						</span>
					</div>
				) : null}
			</HoverCardContent>
		</HoverCard>
	);
});
