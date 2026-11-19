import { split } from "nsh";
import {
	Scrollbar as BaseScrollbar,
	type ScrollbarLook,
	type ScrollbarProps,
} from "nsh/base";
import { classNames } from "./class-names";

export type { ScrollbarProps, ScrollbarLook, ScrollbarTheme } from "nsh/base";

export function scrollbarLook(
	axis: ScrollbarProps["axis"] = "vertical",
): ScrollbarLook {
	return {
		class: classNames(
			"absolute p-px",
			axis === "vertical"
				? "top-0 right-0 h-full w-2.5 border-l border-l-transparent"
				: "bottom-0 left-0 w-full h-1.5 border-t border-t-transparent",
		),
		thumbClass:
			"rounded-full bg-scrollbar-thumb/50 transition-colors hover:bg-scrollbar-thumb-hover/65 active:bg-scrollbar-thumb-active/75",
	};
}

export function Scrollbar(props: ScrollbarProps) {
	const [local, rest] = split(props, ["class", "thumbClass", "axis", "mode"]);
	const look = scrollbarLook(local.axis);
	return (
		<BaseScrollbar
			{...rest}
			axis={local.axis}
			mode={local.mode ?? "hover"}
			class={classNames(look.class, local.class)}
			thumbClass={classNames(look.thumbClass, local.thumbClass)}
		/>
	);
}
