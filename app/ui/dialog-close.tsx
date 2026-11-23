import { View } from "nsh";
import { Icon } from "./icon";

/** The ✕ in a dialog's top-right corner, as React's DialogContent close button; callers pass the label. */
export function DialogClose(props: {
	accessibilityLabel: string;
	onPress: () => void;
	testID?: string;
}) {
	return (
		<View
			testID={props.testID}
			accessibilityLabel={props.accessibilityLabel}
			class="absolute right-3 top-3 size-6 items-center justify-center rounded-xs opacity-70 hover:opacity-100"
			onPress={() => props.onPress()}
		>
			<Icon name="X" size={16} />
		</View>
	);
}
