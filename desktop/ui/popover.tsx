import { split, token } from "nsh";
import { Popover as BasePopover, type PopoverProps } from "nsh/base";
import { styleVar } from "./theme-style";
import { classNames } from "./class-names";

export type { PopoverProps } from "nsh/base";

export function Popover(props: PopoverProps) {
	const [local, rest] = split(props, ["popupClass", "popupStyle"]);
	return (
		<BasePopover
			{...rest}
			popupClass={classNames(
				"rounded-(--pilo-floating-radius) border border-border bg-popover text-popover-foreground p-4 font-sans text-sm",
				local.popupClass,
			)}
			popupStyle={[
				{
					boxShadow: styleVar("pilo-shadow-floating"),
					zIndex: token("z-popover"),
				},
				local.popupStyle,
			]}
		/>
	);
}
