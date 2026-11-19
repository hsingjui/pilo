import { split } from "nsh";
import {
	Switch as BaseSwitch,
	type SwitchProps as BaseSwitchProps,
} from "nsh/base";
import { styleVar } from "./theme-style";

export type SwitchProps = Omit<BaseSwitchProps, "children">;

export function Switch(props: SwitchProps) {
	const [local, rest] = split(props, [
		"class",
		"style",
		"trackClass",
		"thumbClass",
		"thumbStyle",
	]);
	return (
		<BaseSwitch
			{...rest}
			class={[
				"h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50",
				props.checked ? "bg-primary" : "bg-switch-track",
				local.class,
			]
				.filter(Boolean)
				.join(" ")}
			style={[{ boxShadow: styleVar("pilo-shadow-xs") }, local.style]}
			trackClass={["w-9 h-5 p-0.5", local.trackClass].filter(Boolean).join(" ")}
			thumbClass={[
				"size-4 rounded-full bg-background transition-transform",
				props.checked ? "translate-x-4" : "translate-x-0",
				local.thumbClass,
			]
				.filter(Boolean)
				.join(" ")}
			thumbStyle={[{ boxShadow: styleVar("pilo-shadow-lg") }, local.thumbStyle]}
		/>
	);
}
