import { split } from "nsh";
import { Tab as BaseTab, type TabProps } from "nsh/base";
import { styleVar } from "./theme-style";

export type { TabProps } from "nsh/base";

export function Tab(props: TabProps) {
	const [local, rest] = split(props, ["class", "style"]);
	return (
		<BaseTab
			{...rest}
			class={[
				"flex-row items-center justify-center whitespace-nowrap rounded-(--pilo-segment-item-radius) px-3 py-1 text-sm font-medium font-sans focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50",
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
		/>
	);
}
