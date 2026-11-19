import { split } from "nsh";
import { Tabs as BaseTabs, type TabsProps } from "nsh/base";

export type { TabsProps } from "nsh/base";

export function Tabs(props: TabsProps) {
	const [local, rest] = split(props, ["class"]);
	return (
		<BaseTabs
			{...rest}
			class={[
				"flex-row h-9 items-center justify-center self-start rounded-(--pilo-segment-radius) bg-muted p-(--pilo-segment-padding) text-muted-foreground",
				local.class,
			]
				.filter(Boolean)
				.join(" ")}
		/>
	);
}
