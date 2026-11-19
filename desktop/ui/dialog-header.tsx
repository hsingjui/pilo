import { split, View, type ViewProps } from "nsh";
import { classNames } from "./class-names";

export function DialogHeader(props: ViewProps) {
	const [local, rest] = split(props, ["class", "children"]);
	return (
		<View {...rest} class={classNames("gap-1.5", local.class)}>
			{local.children}
		</View>
	);
}
