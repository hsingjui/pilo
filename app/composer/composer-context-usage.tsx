import {
	Canvas,
	computed,
	keyboardFrame,
	Scroll,
	Text,
	token,
	View,
	windowSize,
} from "nsh";
import { Button as BaseButton } from "nsh/base";

import {
	getComposerContextUsage,
	type ChatSessionRuntimeState,
} from "@shared/chat/session-stats";
import {
	finiteNumber,
	formatCompactTokens,
	formatCost,
} from "@shared/format-numbers";

import { t } from "../shell/i18n";
import { chatPx } from "../chat/layout";
import { classNames } from "../ui/class-names";
import { Foreground } from "../ui/foreground";
import { HoverCard } from "../ui/hover-card";
import { Icon } from "../ui/icon";
import { Popover } from "../ui/popover";
import { composerToolbarGap } from "./composer-layout";

/** Mobile text sizes aligned with `web/mobile-typography.ts` (`MOBILE_TEXT`). */
const TOUCH_TEXT = {
	"2xs": { fontSize: 12.5, lineHeight: 16 },
	xs: { fontSize: 13.75, lineHeight: 18 },
	sm: { fontSize: 16, lineHeight: 20 },
	note: { fontSize: 12.5, lineHeight: 18 },
} as const;

/** At most one decimal, as the React composer's `formatPercent`. */
function formatPercent(value: number | undefined) {
	if (value === undefined) return "—";
	if (value >= 100) return "100%";
	return `${Math.round(Math.max(0, value) * 10) / 10}%`;
}

/** The usage ring: a faint track and the used arc from the top. */
function ContextRing(props: { percent: () => number; size?: number }) {
	const color = Foreground();
	const size = () => props.size ?? chatPx(16);
	return (
		<Canvas
			style={{ width: size(), height: size() }}
			accessible={false}
			draw={(cx, canvasSize) => {
				cx.scale(canvasSize.width / 24, canvasSize.height / 24);
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

function DetailRow(props: {
	label: string;
	value: string;
	class?: string;
	touch?: boolean;
}) {
	return (
		<View
			class={classNames(
				"flex-row items-center justify-between gap-3",
				props.class,
			)}
		>
			<Text class={rowLabel} style={props.touch ? TOUCH_TEXT.xs : undefined}>
				{props.label}
			</Text>
			<Text
				class={rowValue}
				style={props.touch ? TOUCH_TEXT["2xs"] : undefined}
			>
				{props.value}
			</Text>
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
	/** Visible height when the host already accounts for the keyboard. */
	availableHeight?: () => number;
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
	const touch = Boolean(props.touch);
	const muted = () => token("muted-foreground");
	const triggerContent = () =>
		percent() === undefined ? (
			<Icon name="CircleDashed" size={touch ? 16 : chatPx(16)} />
		) : (
			<>
				<Text
					class="font-sans font-medium tabular-nums text-muted-foreground"
					style={
						touch
							? TOUCH_TEXT.xs
							: { fontSize: chatPx(12), lineHeight: chatPx(12) }
					}
				>
					{() => formatPercent(percent())}
				</Text>
				<ContextRing percent={ringPercent} size={touch ? 16 : undefined} />
			</>
		);
	const trigger = touch ? (
		<Foreground.Provider value={muted}>
			<BaseButton
				testID="composer-context-usage"
				accessibilityLabel={summary()}
				class="relative shrink-0 flex-row items-center justify-center rounded-(--pilo-mobile-radius-md) hover:bg-hover active:bg-hover"
				style={{
					height: 40,
					minWidth: 40,
					paddingHorizontal: 6,
					gap: 4,
					opacity: stale() ? 0.6 : 1,
				}}
			>
				{triggerContent}
			</BaseButton>
		</Foreground.Provider>
	) : (
		<Foreground.Provider value={muted}>
			<View
				testID="composer-context-usage"
				role="button"
				accessibilityLabel={summary()}
				class="relative shrink-0 flex-row items-center rounded-(--pilo-radius-md) hover:bg-hover active:bg-hover"
				style={{
					height: chatPx(28),
					left: chatPx(4),
					marginLeft: -composerToolbarGap(),
					paddingLeft: chatPx(4),
					gap: chatPx(4),
					opacity: stale() ? 0.6 : 1,
				}}
			>
				{triggerContent}
			</View>
		</Foreground.Provider>
	);
	const details = (
		<View testID="composer-context-usage-details" class="w-full">
			<View
				class={
					touch ? "w-full gap-2.5 px-3.5 py-3" : "w-full gap-2 px-2.5 py-2.5"
				}
			>
				<Text
					class={sectionTitle}
					style={touch ? TOUCH_TEXT["2xs"] : undefined}
				>
					{() => t("chat.contextSection")}
				</Text>
				<View class="flex-row items-baseline justify-between gap-3">
					<Text
						class="font-sans text-sm font-semibold tabular-nums text-popover-foreground"
						style={touch ? TOUCH_TEXT.sm : undefined}
					>
						{() => formatPercent(percent())}
					</Text>
					<Text
						class="font-mono text-[11px] tabular-nums text-muted-foreground"
						style={touch ? TOUCH_TEXT["2xs"] : undefined}
					>
						{() => {
							const { contextTokens, contextWindow } = context();
							return `${formatCompactTokens(contextTokens)} / ${formatCompactTokens(contextWindow)}`;
						}}
					</Text>
				</View>
				<View
					class={classNames(
						"w-full overflow-hidden rounded-full bg-muted",
						touch ? "h-2" : "h-1.5",
					)}
				>
					<View
						class="h-full rounded-full bg-foreground/70"
						style={{ width: `${ringPercent()}%` }}
					/>
				</View>
				{() =>
					percent() === undefined ? (
						<Text
							class="font-sans text-[11px] leading-4 text-muted-foreground"
							style={touch ? TOUCH_TEXT.note : undefined}
						>
							{() => t("chat.contextUsageUnknown")}
						</Text>
					) : stale() ? (
						<Text
							class="font-sans text-[11px] leading-4 text-muted-foreground"
							style={touch ? TOUCH_TEXT.note : undefined}
						>
							{() => t("chat.contextUsageAfterCompaction")}
						</Text>
					) : null
				}
			</View>
			{() =>
				breakdown().length > 0 ? (
					<View
						class={
							touch
								? "w-full gap-2.5 border-t border-border/60 px-3.5 py-2.5"
								: "w-full gap-2 border-t border-border/60 px-2.5 py-2"
						}
					>
						<Text
							class={sectionTitle}
							style={touch ? TOUCH_TEXT["2xs"] : undefined}
						>
							{() => t("chat.tokensSection")}
						</Text>
						<View class={touch ? "gap-2" : "gap-1.5"}>
							{breakdown().map(([label, value]) => (
								<DetailRow
									label={label}
									value={formatCompactTokens(value)}
									touch={touch}
								/>
							))}
						</View>
						{cacheHitRate() !== undefined ? (
							<DetailRow
								label={t("chat.cacheHitRate")}
								value={formatPercent(cacheHitRate())}
								touch={touch}
							/>
						) : null}
						<DetailRow
							class={
								touch
									? "border-t border-border/60 pt-2"
									: "border-t border-border/60 pt-1.5"
							}
							label={t("chat.tokensTotal")}
							value={formatCompactTokens(
								breakdown().reduce((sum, [, value]) => sum + value, 0),
							)}
							touch={touch}
						/>
					</View>
				) : null
			}
			{() =>
				cost() !== undefined ? (
					<View
						class={
							touch
								? "w-full flex-row items-center justify-between gap-3 border-t border-border/60 bg-muted/45 px-3.5 py-2.5"
								: "w-full flex-row items-center justify-between gap-3 border-t border-border/60 bg-muted/45 px-2.5 py-2"
						}
					>
						<Text class={rowLabel} style={touch ? TOUCH_TEXT.xs : undefined}>
							{() => t("chat.totalCost")}
						</Text>
						<Text
							class="font-mono text-[11px] tabular-nums text-foreground"
							style={touch ? TOUCH_TEXT["2xs"] : undefined}
						>
							{() => formatCost(cost())}
						</Text>
					</View>
				) : null
			}
		</View>
	);
	if (touch) {
		const popupWidth = () =>
			Math.min(280, Math.max(200, windowSize().width - 16));
		const maxScrollHeight = () =>
			Math.max(
				160,
				Math.round(
					(props.availableHeight?.() ??
						windowSize().height - keyboardFrame().height) * 0.55,
				),
			);
		return (
			<Popover
				placement="top"
				align="end"
				offset={8}
				margin={8}
				popupClass="overflow-hidden rounded-(--pilo-mobile-context-details-radius) p-0"
				popupStyle={{ width: popupWidth() }}
				trigger={trigger}
			>
				<Scroll bounces={false} style={{ maxHeight: maxScrollHeight() }}>
					{details}
				</Scroll>
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
