import { split, token } from "nsh";
import { Tab as BaseTab, type TabProps } from "nsh/base";
import { styleVar } from "./theme-style";
import { focusRingStyle } from "./focus-ring-style";

export type { TabProps } from "nsh/base";

export function Tab(props: TabProps) {
	const [local, rest] = split(props, ["class", "style", "focusVisibleStyle"]);
	return (
		<BaseTab
			{...rest}
			class={[
				"flex-row items-center justify-center whitespace-nowrap rounded-(--pilo-segment-item-radius) px-3 py-1 text-sm font-medium font-sans focus-visible:outline-hidden disabled:opacity-50",
				props.selected
					? "bg-background text-foreground"
					: "text-muted-foreground",
				local.class,
			]
				.filter(Boolean)
				.join(" ")}
			style={[
				{ boxShadow: props.selected ? styleVar("pilo-shadow-sm") : undefined },
				local.style,
			]}
			focusVisibleStyle={focusRingStyle(
				token("ring"),
				props.selected ? styleVar("pilo-shadow-sm") : undefined,
				local.focusVisibleStyle,
				{ width: 2, opacity: 100, offset: 2, offsetColor: token("background") },
			)}
		/>
	);
}
