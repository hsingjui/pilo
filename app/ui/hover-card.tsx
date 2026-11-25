import { split, token } from "nsh";
import { HoverCard as BaseHoverCard, type HoverCardProps } from "nsh/base";
import { styleVar } from "./theme-style";
import { classNames } from "./class-names";
import { popupMotionStyles } from "./motion";

export type { HoverCardProps } from "nsh/base";

/** A card the pointer resting on its trigger opens; React's HoverCardContent look. */
export function HoverCard(props: HoverCardProps) {
	const [local, rest] = split(props, [
		"popupClass",
		"popupStyle",
		"popupStartingStyle",
		"popupEndingStyle",
	]);
	const motion = () => popupMotionStyles();
	return (
		<BaseHoverCard
			{...rest}
			popupClass={classNames(
				"w-64 rounded-(--pilo-floating-radius) border border-border bg-popover text-popover-foreground font-sans",
				local.popupClass,
			)}
			popupStyle={[
				motion().popupStyle,
				{
					boxShadow: styleVar("pilo-shadow-floating"),
					zIndex: token("z-popover"),
				},
				local.popupStyle,
			]}
			popupStartingStyle={[
				motion().popupStartingStyle,
				local.popupStartingStyle,
			]}
			popupEndingStyle={[motion().popupEndingStyle, local.popupEndingStyle]}
		/>
	);
}
