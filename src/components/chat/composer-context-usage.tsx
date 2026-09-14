import { memo } from "react";

import type { ChatSessionRuntimeState } from "@/components/chat/chat-page-utils";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/ui";

const numberFormatter = new Intl.NumberFormat("zh-CN");
const compactNumberFormatter = new Intl.NumberFormat("en", {
	notation: "compact",
	maximumFractionDigits: 1,
});

const RING_RADIUS = 7;
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

function formatTokens(value: number | null | undefined) {
	const normalized = finiteNumber(value);
	return normalized === undefined
		? "—"
		: numberFormatter.format(Math.max(0, normalized));
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
	if (normalized > 0 && normalized < 1) return `${normalized.toFixed(1)}%`;
	return `${Math.round(normalized)}%`;
}

function formatShare(value: number | undefined, total: number | undefined) {
	if (value === undefined || total === undefined || total <= 0) return "—";
	return formatPercent((value / total) * 100);
}

function formatCost(value: number | undefined) {
	if (value === undefined || !Number.isFinite(value)) return "—";
	if (value < 0.01) return `$${value.toFixed(4)}`;
	return `$${value.toFixed(2)}`;
}

function StatRow({
	label,
	value,
	suffix,
}: {
	label: string;
	value: string;
	suffix?: string;
}) {
	return (
		<div className="flex min-w-0 items-center justify-between gap-4 text-xs">
			<span className="text-muted-foreground">{label}</span>
			<span className="shrink-0 tabular-nums text-foreground">
				{value}
				{suffix ? (
					<span className="ml-1.5 text-[11px] text-muted-foreground">
						{suffix}
					</span>
				) : null}
			</span>
		</div>
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
	const input = finiteNumber(tokens?.input);
	const output = finiteNumber(tokens?.output);
	const cacheRead = finiteNumber(tokens?.cacheRead);
	const cacheWrite = finiteNumber(tokens?.cacheWrite);
	const summedTokens = [input, output, cacheRead, cacheWrite].reduce<number>(
		(total, value) => total + (value ?? 0),
		0,
	);
	const hasTokenBreakdown = [input, output, cacheRead, cacheWrite].some(
		(value) => value !== undefined,
	);
	const totalTokens =
		finiteNumber(tokens?.total) ??
		(hasTokenBreakdown ? summedTokens : undefined);
	const remainingTokens =
		contextTokens !== undefined && contextWindow !== undefined
			? Math.max(0, contextWindow - contextTokens)
			: undefined;

	const ringPercent = Math.min(100, Math.max(0, contextPercent ?? 0));
	const dashOffset = RING_CIRCUMFERENCE * (1 - ringPercent / 100);
	const contextSummary =
		contextPercent === undefined
			? "上下文占用待更新"
			: `上下文占用 ${formatPercent(contextPercent)}`;
	const hasActivityStats = [
		usage?.totalMessages ?? usage?.messageCount,
		usage?.userMessages,
		usage?.assistantMessages,
		usage?.toolCalls,
		usage?.toolResults,
	].some((value) => value !== undefined);

	return (
		<Popover>
			<Tooltip>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<button
							type="button"
							className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground"
							aria-label={contextSummary}
						>
							<span className="relative flex size-5 items-center justify-center">
								<svg
									viewBox="0 0 20 20"
									className="size-5 -rotate-90"
									aria-hidden="true"
								>
									<circle
										cx="10"
										cy="10"
										r={RING_RADIUS}
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										className="opacity-20"
									/>
									{contextPercent !== undefined ? (
										<circle
											cx="10"
											cy="10"
											r={RING_RADIUS}
											fill="none"
											stroke="currentColor"
											strokeWidth="2"
											strokeLinecap="round"
											strokeDasharray={RING_CIRCUMFERENCE}
											strokeDashoffset={dashOffset}
										/>
									) : null}
								</svg>
								{contextPercent === undefined ? (
									<span className="absolute inset-0 flex items-center justify-center text-[11px] font-medium leading-none">
										?
									</span>
								) : null}
							</span>
							<span className="text-xs font-medium tabular-nums leading-none">
								{contextPercent === undefined
									? "—%"
									: formatPercent(contextPercent)}
							</span>
						</button>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipContent>{contextSummary}</TooltipContent>
			</Tooltip>

			<PopoverContent
				side="top"
				align="end"
				sideOffset={8}
				className="w-[320px] p-0"
			>
				<div className="border-b border-border/70 px-3.5 py-3">
					<div className="flex items-start justify-between gap-4">
						<div>
							<div className="text-xs font-medium text-foreground">上下文</div>
							<div className="mt-0.5 text-[11px] text-muted-foreground">
								当前模型上下文窗口
							</div>
						</div>
						<div className="text-right">
							<div className="text-lg font-semibold leading-5 tabular-nums">
								{contextPercent === undefined
									? "—"
									: formatPercent(contextPercent)}
							</div>
							<div className="mt-1 text-[11px] tabular-nums text-muted-foreground">
								{formatCompactTokens(contextTokens)} /{" "}
								{formatCompactTokens(contextWindow)}
							</div>
						</div>
					</div>
					<div className="mt-2.5 h-1 overflow-hidden rounded-full bg-muted">
						<div
							className="h-full rounded-full bg-foreground/70 transition-[width] duration-200"
							style={{ width: `${ringPercent}%` }}
						/>
					</div>
					{contextPercent === undefined ? (
						<p className="mt-2 text-[11px] leading-4 text-muted-foreground">
							当前占用尚不可确定；首次回复或压缩后的下一次模型响应完成后会更新。
						</p>
					) : null}
				</div>

				<div className="space-y-2 px-3.5 py-3">
					<StatRow
						label="当前占用"
						value={formatTokens(contextTokens)}
						suffix="tokens"
					/>
					<StatRow
						label="上下文上限"
						value={formatTokens(contextWindow)}
						suffix="tokens"
					/>
					<StatRow
						label="剩余可用"
						value={formatTokens(remainingTokens)}
						suffix="tokens"
					/>
				</div>

				<div className="border-t border-border/70 px-3.5 py-3">
					<div className="mb-2.5 flex items-center justify-between gap-3">
						<span className="text-xs font-medium text-foreground">
							会话累计 Token
						</span>
						<span className="text-[11px] tabular-nums text-muted-foreground">
							{formatTokens(totalTokens)}
						</span>
					</div>
					<div className="space-y-2">
						<StatRow
							label="输入"
							value={formatTokens(input)}
							suffix={formatShare(input, totalTokens)}
						/>
						<StatRow
							label="输出"
							value={formatTokens(output)}
							suffix={formatShare(output, totalTokens)}
						/>
						<StatRow
							label="缓存读取"
							value={formatTokens(cacheRead)}
							suffix={formatShare(cacheRead, totalTokens)}
						/>
						<StatRow
							label="缓存写入"
							value={formatTokens(cacheWrite)}
							suffix={formatShare(cacheWrite, totalTokens)}
						/>
					</div>
				</div>

				{hasActivityStats || usage?.cost !== undefined ? (
					<div className="border-t border-border/70 px-3.5 py-3">
						<div className="mb-2.5 text-xs font-medium text-foreground">
							会话统计
						</div>
						<div className="space-y-2">
							{usage?.totalMessages !== undefined ||
							usage?.messageCount !== undefined ? (
								<StatRow
									label="消息总数"
									value={formatTokens(
										usage.totalMessages ?? usage.messageCount,
									)}
								/>
							) : null}
							{usage?.userMessages !== undefined ? (
								<StatRow
									label="用户消息"
									value={formatTokens(usage.userMessages)}
								/>
							) : null}
							{usage?.assistantMessages !== undefined ? (
								<StatRow
									label="模型消息"
									value={formatTokens(usage.assistantMessages)}
								/>
							) : null}
							{usage?.toolCalls !== undefined ? (
								<StatRow
									label="工具调用"
									value={formatTokens(usage.toolCalls)}
								/>
							) : null}
							{usage?.toolResults !== undefined ? (
								<StatRow
									label="工具结果"
									value={formatTokens(usage.toolResults)}
								/>
							) : null}
							{usage?.cost !== undefined ? (
								<StatRow label="累计费用" value={formatCost(usage.cost)} />
							) : null}
						</div>
					</div>
				) : null}
			</PopoverContent>
		</Popover>
	);
});
