import { View } from "nsh";
import { Icon } from "./icon";

/**
 * A trailing check slot for a menu row that hides MenuItem's leading
 * indicator (`indicatorClass="hidden"`), as Select's trailing check; it
 * keeps its 16pt box unchecked so labels do not shift.
 */
export function MenuCheck(props: { checked: () => boolean }) {
	return (
		<View class="size-4 shrink-0 items-center justify-center">
			{() => (props.checked() ? <Icon name="Check" size={14} /> : null)}
		</View>
	);
}
