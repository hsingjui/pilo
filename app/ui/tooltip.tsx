import { split, Text, token } from "nsh";
import { Tooltip as BaseTooltip, type TooltipProps } from "nsh/base";
import type { TextStyle } from "nsh/types";
import { styleVar } from "./theme-style";
import { classNames } from "./class-names";
import { tooltipMotionStyles } from "./motion";

export type { TooltipProps } from "nsh/base";

// Claude adds these at runtime, so nsh's default-theme types omit them.
declare module "nsh" {
	interface Tokens {
		"tooltip-background"?: string;
		"tooltip-foreground"?: string;
	}
}

export function tooltipStyle(): TextStyle {
	return {
		backgroundColor: token("tooltip-background") ?? token("popover"),
		color: token("tooltip-foreground") ?? token("popover-foreground"),
		boxShadow: styleVar("pilo-tooltip-shadow"),
	};
}

export function Tooltip(props: TooltipProps) {
	const [local, rest] = split(props, [
		"class",
		"style",
		"startingStyle",
		"endingStyle",
	]);
	const motion = () => tooltipMotionStyles();
	return (
		<BaseTooltip
			{...rest}
			class={classNames(
				"overflow-hidden rounded-(--pilo-radius-md) border border-(--pilo-tooltip-border) px-3 py-1.5 text-xs font-sans",
				local.class,
			)}
			style={[
				motion().style,
				tooltipStyle(),
				{ zIndex: token("z-tooltip") },
				local.style,
			]}
			startingStyle={[motion().startingStyle, local.startingStyle]}
			endingStyle={[motion().endingStyle, local.endingStyle]}
		/>
	);
}

/** A plain-text tooltip bubble for icon-only controls and short hints. */
export function textTooltip(label: string | (() => string)) {
	return (
		<Tooltip>
			<Text class="font-sans">{label}</Text>
		</Tooltip>
	);
}
