import { split, token } from "nsh";
import {
	Switch as BaseSwitch,
	type SwitchProps as BaseSwitchProps,
} from "nsh/base";
import { styleVar } from "./theme-style";
import { focusRingStyle } from "./focus-ring-style";
import { springTransition, tactileTransition } from "./motion";

export type SwitchProps = Omit<BaseSwitchProps, "children">;

export function Switch(props: SwitchProps) {
	const [local, rest] = split(props, [
		"class",
		"style",
		"trackClass",
		"thumbClass",
		"thumbStyle",
		"focusVisibleStyle",
	]);
	return (
		<BaseSwitch
			{...rest}
			class={[
				"h-5 w-9 shrink-0 rounded-full focus-visible:outline-hidden disabled:opacity-50",
				props.checked ? "bg-primary" : "bg-switch-track",
				local.class,
			]
				.filter(Boolean)
				.join(" ")}
			style={[
				tactileTransition("background-color, box-shadow, opacity"),
				{ boxShadow: styleVar("pilo-shadow-xs") },
				local.style,
			]}
			focusVisibleStyle={focusRingStyle(
				token("ring"),
				styleVar("pilo-shadow-xs"),
				local.focusVisibleStyle,
				{ width: 2, opacity: 100, offset: 2, offsetColor: token("background") },
			)}
			trackClass={["w-9 h-5 p-0.5", local.trackClass].filter(Boolean).join(" ")}
			thumbClass={[
				"size-4 rounded-full bg-background origin-left active:scale-x-[1.18] checked:origin-right",
				props.checked ? "translate-x-4" : "translate-x-0",
				local.thumbClass,
			]
				.filter(Boolean)
				.join(" ")}
			thumbStyle={[
				springTransition("transform", "crisp"),
				{ boxShadow: styleVar("pilo-shadow-lg") },
				local.thumbStyle,
			]}
		/>
	);
}
