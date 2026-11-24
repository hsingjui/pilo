import { type JSX, platform, Text, token } from "nsh";

import { Button } from "../ui/button";
import { Foreground } from "../ui/foreground";
import { createHover } from "../ui/hover";
import { Tooltip } from "../ui/tooltip";
import { chatFooterHeight } from "./layout";

/** The React message footer's ghost action, shared by Copy and Fork. */
export function ChatMessageAction(props: {
	label: string;
	testID?: string;
	disabled?: boolean;
	compact?: boolean;
	visible?: boolean;
	onPress: () => void;
	children?: JSX.Element;
}) {
	const hover = createHover();
	const size = chatFooterHeight(platform.desktop);
	const width =
		props.compact && platform.os === "web" ? Math.min(size, 32) : size;
	return (
		<Button
			testID={props.testID}
			variant="ghost"
			size="icon"
			class="rounded-(--pilo-radius-md) transition-opacity duration-100"
			style={{
				width,
				height: size,
				opacity: props.visible === false ? 0 : 1,
			}}
			focusVisibleStyle={{ opacity: 1 }}
			disabledStyle={{ opacity: 0.5 }}
			disabled={props.disabled}
			accessibilityLabel={props.label}
			tooltip={
				<Tooltip>
					<Text class="font-sans">{() => props.label}</Text>
				</Tooltip>
			}
			{...hover.props}
			onPress={props.onPress}
		>
			<Foreground.Provider
				value={() =>
					token(
						hover.hovered() && !props.disabled
							? "hover-foreground"
							: "muted-foreground",
					)
				}
			>
				{props.children}
			</Foreground.Provider>
		</Button>
	);
}
