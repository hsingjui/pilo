import { split, View, type ViewProps } from "nsh";

import { classNames } from "../ui/class-names";

/** The centered column a chat's messages share with what sits under them. */
export function ConversationColumn(props: ViewProps) {
	const [local, rest] = split(props, ["class", "children"]);
	return (
		<View class="w-full items-center">
			<View
				{...rest}
				class={classNames("w-[80%] max-w-[52rem] px-4", local.class)}
			>
				{local.children}
			</View>
		</View>
	);
}
