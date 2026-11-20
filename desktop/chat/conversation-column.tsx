import {
	computed,
	context,
	split,
	View,
	type Accessor,
	type ViewProps,
} from "nsh";

import { DEFAULT_CHAT_REM } from "./layout";

export const ConversationColumnLayout = context<
	Accessor<{ claude: boolean; narrow: boolean }>
>(() => ({ claude: false, narrow: false }));

export function conversationColumnGeometry(claude: boolean, narrow: boolean) {
	return {
		widthPercent: claude ? 94 : 80,
		maxWidth: (claude ? 48 : 52) * DEFAULT_CHAT_REM,
		paddingHorizontal: (narrow ? 0.75 : 1) * DEFAULT_CHAT_REM,
	};
}

/** The centered column a chat's messages share with what sits under them. */
export function ConversationColumn(props: ViewProps) {
	const layout = ConversationColumnLayout();
	const geometry = computed(() =>
		conversationColumnGeometry(layout().claude, layout().narrow),
	);
	const [local, rest] = split(props, ["style", "children"]);
	return (
		<View class="w-full items-center">
			<View
				{...rest}
				style={[
					{
						width: `${geometry().widthPercent}%`,
						maxWidth: geometry().maxWidth,
						paddingHorizontal: geometry().paddingHorizontal,
					},
					local.style,
				]}
			>
				{local.children}
			</View>
		</View>
	);
}
