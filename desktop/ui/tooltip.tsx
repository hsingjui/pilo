import { split, token } from "nsh";
import { Tooltip as BaseTooltip, type TooltipProps } from "nsh/base";
import type { TextStyle } from "nsh/types";
import { styleVar } from "./theme-style";
import { classNames } from "./class-names";

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
	const [local, rest] = split(props, ["class", "style"]);
	return (
		<BaseTooltip
			{...rest}
			class={classNames(
				"overflow-hidden rounded-(--pilo-radius-md) border border-(--pilo-tooltip-border) px-3 py-1.5 text-xs font-sans",
				local.class,
			)}
			style={[tooltipStyle(), { zIndex: token("z-tooltip") }, local.style]}
		/>
	);
}
