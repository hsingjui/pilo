import { split, token } from "nsh";
import { Tab as BaseTab, type TabProps } from "nsh/base";
import { focusRingStyle } from "./focus-ring-style";
import { tactileTransition } from "./motion";

export type { TabProps } from "nsh/base";

export function Tab(props: TabProps) {
	const [local, rest] = split(props, ["class", "style", "focusVisibleStyle"]);
	return (
		<BaseTab
			{...rest}
			class={[
				"flex-row items-center justify-center whitespace-nowrap rounded-(--pilo-segment-item-radius) px-3 py-1 text-sm font-medium font-sans focus-visible:outline-hidden disabled:opacity-50",
				props.selected
					? "text-foreground"
					: "text-muted-foreground hover:text-foreground/80",
				local.class,
			]
				.filter(Boolean)
				.join(" ")}
			style={[tactileTransition("color, opacity, box-shadow"), local.style]}
			focusVisibleStyle={focusRingStyle(
				token("ring"),
				undefined,
				local.focusVisibleStyle,
				{ width: 2, opacity: 100, offset: 2, offsetColor: token("background") },
			)}
		/>
	);
}
