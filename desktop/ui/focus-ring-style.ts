import type { StyleProp, ViewStyle } from "nsh";

interface FocusRingOptions {
	width?: number;
	opacity?: number;
	offset?: number;
	offsetColor?: string;
}

export function focusRingStyle(
	color: string,
	shadow?: string,
	callerStyle?: StyleProp<ViewStyle>,
	options: FocusRingOptions = {},
): StyleProp<ViewStyle> {
	const offset = options.offset ?? 0;
	const opacity = options.opacity ?? 60;
	const ringColor =
		opacity === 100
			? color
			: `color-mix(in srgb, ${color} ${opacity}%, transparent)`;
	const ring = [
		offset > 0
			? `0 0 0 ${offset}px ${options.offsetColor ?? "transparent"}`
			: undefined,
		`0 0 0 ${(options.width ?? 1) + offset}px ${ringColor}`,
	]
		.filter(Boolean)
		.join(", ");
	return [
		{ boxShadow: shadow && shadow !== "none" ? `${ring}, ${shadow}` : ring },
		callerStyle,
	];
}
