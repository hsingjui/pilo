import { token, View } from "nsh";
import { Icon } from "./icon";
import { springTransition } from "./motion";

export interface CopyStatusIconProps {
	/** Whether the copy succeeded and the checkmark should be shown. */
	copied: () => boolean;
	size?: number;
	color?: string;
	copiedColor?: string;
}

/**
 * Cross-scales between Copy and Check icons with a crisp spring so copy
 * confirmations read clearly in both directions without layout shift.
 */
export function CopyStatusIcon(props: CopyStatusIconProps) {
	const size = () => props.size ?? 14;
	const box = () => ({ width: size(), height: size() });
	const transition = () => springTransition("opacity, transform", "crisp");
	return (
		<View class="relative shrink-0 items-center justify-center" style={box()}>
			<View
				class="absolute inset-0 items-center justify-center"
				style={[
					transition(),
					props.copied()
						? { opacity: 0, transform: [{ scale: 0.65 }] }
						: { opacity: 1, transform: [{ scale: 1 }] },
				]}
			>
				<Icon name="Copy" size={size()} color={props.color} />
			</View>
			<View
				class="absolute inset-0 items-center justify-center"
				style={[
					transition(),
					props.copied()
						? { opacity: 1, transform: [{ scale: 1 }] }
						: { opacity: 0, transform: [{ scale: 0.65 }] },
				]}
			>
				<Icon
					name="Check"
					size={size()}
					color={props.copiedColor ?? token("status-success")}
				/>
			</View>
		</View>
	);
}
