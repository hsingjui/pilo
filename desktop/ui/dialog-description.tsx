import { split, Text, type TextProps } from "nsh";
import { classNames } from "./class-names";

export function DialogDescription(props: TextProps) {
	const [local, rest] = split(props, ["class", "children"]);
	return (
		<Text
			{...rest}
			class={classNames("text-sm text-muted-foreground", local.class)}
		>
			{local.children}
		</Text>
	);
}
