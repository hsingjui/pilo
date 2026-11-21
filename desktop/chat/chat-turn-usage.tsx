import {
	computed,
	platform,
	reduceMotion,
	signal,
	Text,
	token,
	View,
} from "nsh";

import type { TokenUsage } from "@shared/api/token-usage";
import { formatCompactTokens, formatCost } from "@shared/format-numbers";

import { t } from "../app/i18n";
import { focusRingStyle } from "../ui/focus-ring-style";
import { HoverCard } from "../ui/hover-card";
import { Icon } from "../ui/icon";
import { Popover } from "../ui/popover";
import { chatMetadataText, chatPx } from "./layout";

function UsageDetails(props: { usage: TokenUsage }) {
	const breakdown = computed(() => {
		const { input, output, cacheRead, cacheWrite } = props.usage;
		return [
			[t("chat.input"), formatCompactTokens(input)],
			[t("chat.output"), formatCompactTokens(output)],
			[t("chat.cacheRead"), formatCompactTokens(cacheRead)],
			[t("chat.cacheWrite"), formatCompactTokens(cacheWrite)],
		];
	});
	const cost = () => props.usage.cost;
	const totalStyle = { ...chatMetadataText, paddingTop: chatPx(2) };
	const labelClass = "font-sans text-muted-foreground";
	const valueClass =
		"font-mono tabular-nums text-right text-popover-foreground";
	return (
		<View style={{ gap: chatPx(2) }}>
			<Text
				class="font-sans font-semibold uppercase text-muted-foreground"
				style={{
					...chatMetadataText,
					letterSpacing: 0.6,
					paddingBottom: chatPx(2),
				}}
			>
				{() => t("chat.turnTokens")}
			</Text>
			<View class="flex-row" style={{ gap: chatPx(12) }}>
				<View style={{ gap: chatPx(2) }}>
					{() =>
						breakdown().map(([label]) => (
							<Text class={labelClass} style={chatMetadataText}>
								{label}
							</Text>
						))
					}
					<Text
						class={`${labelClass} border-t border-border/60`}
						style={totalStyle}
					>
						{() => t("chat.tokensTotal")}
					</Text>
					{() =>
						(cost() ?? 0) > 0 ? (
							<Text class={labelClass} style={chatMetadataText}>
								{() => t("chat.turnCost")}
							</Text>
						) : null
					}
				</View>
				<View style={{ gap: chatPx(2) }}>
					{() =>
						breakdown().map(([, value]) => (
							<Text class={valueClass} style={chatMetadataText}>
								{value}
							</Text>
						))
					}
					<Text
						class={`${valueClass} border-t border-border/60`}
						style={totalStyle}
					>
						{() => formatCompactTokens(props.usage.total)}
					</Text>
					{() =>
						(cost() ?? 0) > 0 ? (
							<Text class={valueClass} style={chatMetadataText}>
								{() => formatCost(cost())}
							</Text>
						) : null
					}
				</View>
			</View>
		</View>
	);
}

/** The reply is primary; a muted total in its footer opens the breakdown. */
export function ChatTurnUsage(props: { usage: TokenUsage }) {
	const open = signal(false);
	const total = () => formatCompactTokens(props.usage.total);
	const UsageCard = platform.desktop ? HoverCard : Popover;
	return (
		<UsageCard
			{...(platform.desktop ? { openDelay: 0, closeDelay: 150 } : {})}
			open={open()}
			onOpenChange={({ open: next }) => open.set(next)}
			placement="top"
			offset={chatPx(8)}
			margin={8}
			popupClass="w-auto transition-[opacity,transform] duration-150"
			popupStyle={{ padding: chatPx(8) }}
			popupStartingClass={
				reduceMotion() ? "opacity-0" : "opacity-0 scale-95 translate-y-2"
			}
			popupEndingClass={reduceMotion() ? "opacity-0" : "opacity-0 scale-95"}
			trigger={
				<View
					testID="chat-turn-usage"
					accessible
					role="button"
					accessibilityLabel={`${t("chat.turnTokens")}: ${total()}`}
					accessibilityState={{ expanded: open() }}
					focusable
					class="shrink-0 flex-row items-center rounded-(--pilo-radius-sm)"
					style={{ gap: chatPx(4) }}
					hitSlop={platform.desktop ? undefined : 14}
					focusVisibleStyle={focusRingStyle(
						token("ring"),
						undefined,
						undefined,
						{
							width: 2,
							opacity: 100,
						},
					)}
					onFocus={platform.desktop ? () => open.set(true) : undefined}
					onBlur={platform.desktop ? () => open.set(false) : undefined}
					onPress={platform.desktop ? () => open.set(true) : undefined}
				>
					<Icon
						name="Coins"
						size={chatPx(12)}
						class="opacity-70"
						color={token("muted-foreground")}
					/>
					<Text
						class="font-mono tabular-nums text-muted-foreground"
						style={chatMetadataText}
					>
						{total}
					</Text>
				</View>
			}
		>
			<UsageDetails usage={props.usage} />
		</UsageCard>
	);
}
