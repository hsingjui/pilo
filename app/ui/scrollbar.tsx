import { split } from "nsh";
import {
	Scrollbar as BaseScrollbar,
	type ScrollbarLook,
	type ScrollbarProps,
	type ScrollbarTheme,
} from "nsh/base";
import { classNames } from "./class-names";
import { MOTION, tactileTransition } from "./motion";

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
			"rounded-full bg-scrollbar-thumb/50 hover:bg-scrollbar-thumb-hover/65 active:bg-scrollbar-thumb-active/75",
		thumbStyle: tactileTransition("background-color"),
	};
}

/** Built-in scrollbar theme helper with unified fade-in/out motion. */
export function scrollbarTheme(
	options?: Omit<ScrollbarTheme, "motion"> & {
		motion?: ScrollbarTheme["motion"];
	},
): ScrollbarTheme {
	return {
		motion: MOTION.scrollbar,
		vertical: scrollbarLook("vertical"),
		...options,
	};
}

export function Scrollbar(props: ScrollbarProps) {
	const [local, rest] = split(props, [
		"class",
		"thumbClass",
		"thumbStyle",
		"axis",
		"mode",
		"motion",
	]);
	const look = scrollbarLook(local.axis);
	return (
		<BaseScrollbar
			{...rest}
			axis={local.axis}
			mode={local.mode ?? "hover"}
			motion={local.motion ?? MOTION.scrollbar}
			class={classNames(look.class, local.class)}
			thumbClass={classNames(look.thumbClass, local.thumbClass)}
			thumbStyle={[look.thumbStyle, local.thumbStyle]}
		/>
	);
}
