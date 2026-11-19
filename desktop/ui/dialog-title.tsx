import { split, Text, type TextProps } from "nsh";
import { classNames } from "./class-names";

export function DialogTitle(props: TextProps) {
	const [local, rest] = split(props, ["class", "children"]);
	return (
		<Text
			role="header"
			{...rest}
			class={classNames("text-lg font-semibold leading-tight", local.class)}
		>
			{local.children}
		</Text>
	);
}
