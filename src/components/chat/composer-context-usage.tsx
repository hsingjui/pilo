import { CircleDashed } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { i18n } from "@/i18n";
import type { ChatSessionRuntimeState } from "@/components/chat/chat-page-utils";
import { cn } from "@/lib/utils";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/ui";

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
		: new Intl.NumberFormat(i18n.language, { notation: "compact" }).format(
				Math.max(0, normalized),
			);
}

function formatPercent(value: number | null | undefined) {
	const normalized = finiteNumber(value);
	if (normalized === undefined) return "—";
	if (normalized >= 100) return "100%";
	return `${new Intl.NumberFormat(i18n.language, {
		maximumFractionDigits: 1,
	}).format(Math.max(0, normalized))}%`;
}

function formatCost(value: number | undefined) {
	if (value === undefined || !Number.isFinite(value)) return "—";
	if (value < 0.01) return `$${value.toFixed(4)}`;
	return `$${value.toFixed(2)}`;
}

function ContextIcon({
	percent,
	spinning,
	onSpinEnd,
}: {
	percent: number;
	spinning: boolean;
	onSpinEnd: () => void;
}) {
	const dashOffset = RING_CIRCUMFERENCE * (1 - percent / 100);

	return (
		<svg
			viewBox="0 0 24 24"
			className={cn(
				"size-4 origin-center",
				spinning && "context-usage-update-spin",
			)}
			aria-hidden="true"
			onAnimationEnd={onSpinEnd}
		>
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
				style={{ transition: "stroke-dashoffset 400ms ease-out" }}
				className="-rotate-90 origin-center opacity-70"
			/>
		</svg>
	);
}

export const ComposerContextUsage = memo(function ComposerContextUsage({
	usage,
	contextWindow: modelContextWindow,
}: ComposerContextUsageProps) {
	const { t } = useTranslation();
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
			[t("chat.input"), finiteNumber(tokens?.input)],
			[t("chat.output"), finiteNumber(tokens?.output)],
			[t("chat.cacheRead"), finiteNumber(tokens?.cacheRead)],
			[t("chat.cacheWrite"), finiteNumber(tokens?.cacheWrite)],
		] as Array<[string, number | undefined]>
	).filter(
		(entry): entry is [string, number] =>
			entry[1] !== undefined && entry[1] > 0,
	);

	const ringPercent = Math.min(100, Math.max(0, contextPercent ?? 0));
	// HoverCard 只响应指针悬浮，这里受控补上键盘路径：focus-visible 打开，失焦关闭
	const [open, setOpen] = useState(false);
	// 占用值刷新后圆环自转一圈，替代文字提示更新的做法。
	const [spinning, setSpinning] = useState(false);
	const previousPercentRef = useRef(contextPercent);
	useEffect(() => {
		const previous = previousPercentRef.current;
		previousPercentRef.current = contextPercent;
		if (
			previous === undefined ||
			contextPercent === undefined ||
			previous === contextPercent
		) {
			return;
		}
		setSpinning(true);
	}, [contextPercent]);
	const contextSummary =
		contextPercent === undefined
			? t("chat.contextUsagePending")
			: contextStale
				? t("chat.contextUsageKnownPending")
				: t("chat.contextUsage", {
						percent: formatPercent(contextPercent),
					});

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
							<ContextIcon
								percent={ringPercent}
								spinning={spinning}
								onSpinEnd={() => setSpinning(false)}
							/>
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
						<p className="font-mono text-2xs tabular-nums text-muted-foreground">
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
						<p className="text-2xs leading-4 text-muted-foreground">
							{t("chat.contextUsageUnknown")}
						</p>
					) : contextStale ? (
						<p className="text-2xs leading-4 text-muted-foreground">
							{t("chat.contextUsageAfterCompaction")}
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
								<span className="font-mono text-2xs tabular-nums text-foreground">
									{formatCompactTokens(value)}
								</span>
							</div>
						))}
					</div>
				) : null}

				{usage?.cost !== undefined ? (
					<div className="flex w-full items-center justify-between gap-3 bg-muted/45 px-2.5 py-2 text-xs">
						<span className="text-muted-foreground">{t("chat.totalCost")}</span>
						<span className="font-mono text-2xs tabular-nums">
							{formatCost(usage.cost)}
						</span>
					</div>
				) : null}
			</HoverCardContent>
		</HoverCard>
	);
});
