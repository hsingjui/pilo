import { split } from "nsh";
import { Tabs as BaseTabs, type TabsProps } from "nsh/base";
import { classNames } from "./class-names";
import { styleVar } from "./theme-style";

export type { TabsProps } from "nsh/base";

export function Tabs(props: TabsProps) {
	const [local, rest] = split(props, [
		"class",
		"indicatorClass",
		"indicatorStyle",
	]);
	return (
		<BaseTabs
			{...rest}
			class={classNames(
				"flex-row h-9 items-center justify-center self-start rounded-(--pilo-segment-radius) bg-muted p-(--pilo-segment-padding) text-muted-foreground",
				local.class,
			)}
			indicatorClass={classNames(
				"inset-y-(--pilo-segment-padding) rounded-(--pilo-segment-item-radius) bg-background",
				local.indicatorClass,
			)}
			indicatorStyle={[
				{ boxShadow: styleVar("pilo-shadow-sm") },
				local.indicatorStyle,
			]}
		/>
	);
}
