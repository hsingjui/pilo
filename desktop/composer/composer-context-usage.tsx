import { Canvas, computed, Text, token, View } from "nsh";

import {
	getComposerContextUsage,
	type ChatSessionRuntimeState,
} from "@shared/chat/session-stats";
import {
	finiteNumber,
	formatCompactTokens,
	formatCost,
} from "@shared/format-numbers";

import { t } from "../app/i18n";
import { chatPx } from "../chat/layout";
import { Foreground } from "../ui/foreground";
import { HoverCard } from "../ui/hover-card";
import { Icon } from "../ui/icon";
import { Popover } from "../ui/popover";
import { composerToolbarGap } from "./composer-layout";

/** At most one decimal, as the React composer's `formatPercent`. */
function formatPercent(value: number | undefined) {
	if (value === undefined) return "—";
	if (value >= 100) return "100%";
	return `${Math.round(Math.max(0, value) * 10) / 10}%`;
}

/** The usage ring: a faint track and the used arc from the top. */
function ContextRing(props: { percent: () => number }) {
	const color = Foreground();
	return (
		<Canvas
			style={{ width: chatPx(16), height: chatPx(16) }}
			accessible={false}
			draw={(cx, size) => {
				cx.scale(size.width / 24, size.height / 24);
				cx.strokeStyle = color();
				cx.lineWidth = 2;
				cx.lineCap = "round";
				cx.globalAlpha = 0.25;
				cx.beginPath();
				cx.arc(12, 12, 10, 0, Math.PI * 2);
				cx.stroke();
				if (props.percent() <= 0) return;
				cx.globalAlpha = 0.7;
				cx.beginPath();
				cx.arc(
					12,
					12,
					10,
					-Math.PI / 2,
					-Math.PI / 2 + (Math.PI * 2 * props.percent()) / 100,
				);
				cx.stroke();
			}}
		/>
	);
}

const sectionTitle =
	"font-sans text-[11px] font-semibold uppercase leading-tight tracking-[0.6px] text-muted-foreground";
const rowLabel = "font-sans text-xs text-muted-foreground";
const rowValue = "font-mono text-[11px] tabular-nums text-popover-foreground";

function DetailRow(props: { label: string; value: string; class?: string }) {
	return (
		<View
			class={["flex-row items-center justify-between", props.class]
				.filter(Boolean)
				.join(" ")}
		>
			<Text class={rowLabel}>{props.label}</Text>
			<Text class={rowValue}>{props.value}</Text>
		</View>
	);
}

/**
 * The composer's context usage: the percent and a ring, its details (the
 * context, the session's tokens and cost) in a card on hover, as the React
 * `ComposerContextUsage`.
 */
export function ComposerContextUsage(props: {
	usage: () => ChatSessionRuntimeState | null;
	/** The selected model's window. */
	contextWindow: () => number | undefined;
	/** Uses tap-to-open Popover with 40px touch height on mobile / WebUI. */
	touch?: boolean;
}) {
	const context = computed(() =>
		getComposerContextUsage(props.usage(), props.contextWindow()),
	);
	const stale = () => props.usage()?.contextStale === true;
	const percent = () => context().contextPercent;
	const ringPercent = () => Math.min(100, Math.max(0, percent() ?? 0));
	const breakdown = () => {
		const tokens = props.usage()?.tokens;
		return (
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
	};
	// Cache hits over all input: how much of the input the cache served.
	const cacheHitRate = () => {
		const tokens = props.usage()?.tokens;
		const input = finiteNumber(tokens?.input) ?? 0;
		const cacheRead = finiteNumber(tokens?.cacheRead) ?? 0;
		return input + cacheRead > 0
			? (cacheRead / (input + cacheRead)) * 100
			: undefined;
	};
	const cost = () => finiteNumber(props.usage()?.cost);
	const summary = () =>
		percent() === undefined
			? t("chat.contextUsagePending")
			: stale()
				? t("chat.contextUsageKnownPending")
				: t("chat.contextUsage", { percent: formatPercent(percent()) });
	const muted = () => token("muted-foreground");
	const trigger = (
		<Foreground.Provider value={muted}>
			<View
				testID="composer-context-usage"
				role="button"
				accessibilityLabel={summary()}
				class="relative shrink-0 flex-row items-center rounded-(--pilo-radius-md) hover:bg-hover active:bg-hover"
				style={
					props.touch
						? {
								height: 40,
								paddingHorizontal: 6,
								gap: 4,
								opacity: stale() ? 0.6 : 1,
							}
						: {
								height: chatPx(28),
								left: chatPx(4),
								marginLeft: -composerToolbarGap(),
								paddingLeft: chatPx(4),
								gap: chatPx(4),
								opacity: stale() ? 0.6 : 1,
							}
				}
			>
				{() =>
					percent() === undefined ? (
						<Icon name="CircleDashed" size={props.touch ? 16 : chatPx(16)} />
					) : (
						<>
							<Text
								class="font-sans font-medium tabular-nums text-muted-foreground"
								style={{ fontSize: chatPx(12), lineHeight: chatPx(12) }}
							>
								{() => formatPercent(percent())}
							</Text>
							<ContextRing percent={ringPercent} />
						</>
					)
				}
			</View>
		</Foreground.Provider>
	);
	const details = (
		<>
			<View class="w-full gap-2 px-2.5 py-2.5">
				<Text class={sectionTitle}>{() => t("chat.contextSection")}</Text>
				<View class="flex-row items-baseline justify-between gap-3">
					<Text class="font-sans text-sm font-semibold tabular-nums text-popover-foreground">
						{() => formatPercent(percent())}
					</Text>
					<Text class="font-mono text-[11px] tabular-nums text-muted-foreground">
						{() => {
							const { contextTokens, contextWindow } = context();
							return `${formatCompactTokens(contextTokens)} / ${formatCompactTokens(contextWindow)}`;
						}}
					</Text>
				</View>
				<View class="h-1.5 w-full overflow-hidden rounded-full bg-muted">
					<View
						class="h-full rounded-full bg-foreground/70"
						style={{ width: `${ringPercent()}%` }}
					/>
				</View>
				{() =>
					percent() === undefined ? (
						<Text class="font-sans text-[11px] leading-4 text-muted-foreground">
							{() => t("chat.contextUsageUnknown")}
						</Text>
					) : stale() ? (
						<Text class="font-sans text-[11px] leading-4 text-muted-foreground">
							{() => t("chat.contextUsageAfterCompaction")}
						</Text>
					) : null
				}
			</View>
			{() =>
				breakdown().length > 0 ? (
					<View class="w-full gap-2 border-t border-border/60 px-2.5 py-2">
						<Text class={sectionTitle}>{() => t("chat.tokensSection")}</Text>
						<View class="gap-1.5">
							{breakdown().map(([label, value]) => (
								<DetailRow label={label} value={formatCompactTokens(value)} />
							))}
						</View>
						{cacheHitRate() !== undefined ? (
							<DetailRow
								label={t("chat.cacheHitRate")}
								value={formatPercent(cacheHitRate())}
							/>
						) : null}
						<DetailRow
							class="border-t border-border/60 pt-1.5"
							label={t("chat.tokensTotal")}
							value={formatCompactTokens(
								breakdown().reduce((sum, [, value]) => sum + value, 0),
							)}
						/>
					</View>
				) : null
			}
			{() =>
				cost() !== undefined ? (
					<View class="w-full flex-row items-center justify-between gap-3 border-t border-border/60 bg-muted/45 px-2.5 py-2">
						<Text class={rowLabel}>{() => t("chat.totalCost")}</Text>
						<Text class="font-mono text-[11px] tabular-nums text-foreground">
							{() => formatCost(cost())}
						</Text>
					</View>
				) : null
			}
		</>
	);
	if (props.touch) {
		return (
			<Popover
				placement="top"
				align="end"
				offset={8}
				popupClass="w-[248px] overflow-hidden rounded-(--pilo-context-details-radius) p-0"
				trigger={trigger}
			>
				{details}
			</Popover>
		);
	}
	return (
		<HoverCard
			openDelay={0}
			closeDelay={150}
			placement="top"
			align="end"
			offset={8}
			popupClass="w-[248px] overflow-hidden rounded-(--pilo-context-details-radius) p-0"
			trigger={trigger}
		>
			{details}
		</HoverCard>
	);
}
