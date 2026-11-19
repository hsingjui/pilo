import { split, token } from "nsh";
import { Tooltip as BaseTooltip, type TooltipProps } from "nsh/base";
import { styleVar } from "./theme-style";
import { classNames } from "./class-names";

export type { TooltipProps } from "nsh/base";

export function Tooltip(props: TooltipProps) {
	const [local, rest] = split(props, ["class", "style"]);
	return (
		<BaseTooltip
			{...rest}
			class={classNames(
				"overflow-hidden rounded-(--pilo-radius-md) border border-(--pilo-tooltip-border) bg-popover bg-(--tooltip-background) text-popover-foreground text-(--tooltip-foreground) px-3 py-1.5 text-xs font-sans",
				local.class,
			)}
			style={[
				{
					boxShadow: styleVar("pilo-tooltip-shadow"),
					zIndex: token("z-tooltip"),
				},
				local.style,
			]}
		/>
	);
}
