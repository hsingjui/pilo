import { split, View, type ViewProps } from "nsh";
import { classNames } from "./class-names";

export function DialogFooter(props: ViewProps) {
	const [local, rest] = split(props, ["class", "children"]);
	return (
		<View
			{...rest}
			class={classNames("flex-row flex-wrap justify-end gap-2", local.class)}
		>
			{local.children}
		</View>
	);
}
