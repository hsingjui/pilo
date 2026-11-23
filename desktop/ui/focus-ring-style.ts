import type { MouseEvent, StyleProp, ViewRef, ViewStyle } from "nsh";

interface FocusRingOptions {
	width?: number;
	opacity?: number;
	offset?: number;
	offsetColor?: string;
}

export interface PointerBlurProps {
	ref?: ViewRef | ((node: ViewRef) => void);
	onMouseUp?: (event: MouseEvent) => void;
}

/**
 * Releases pointer-acquired focus from a button before `onPress` opens a
 * modal or popup. On desktop hosts that focus buttons on click (Windows),
 * closing a dialog or menu with Escape restores focus to the previously
 * focused control with keyboard modality (`focus-visible`), leaving a focus
 * ring and its `Tooltip` stuck open until focus moves elsewhere. Because
 * `onMouseUp` fires only for pointer releases (not keyboard Enter/Space),
 * keyboard navigation (`Tab` → `Enter`/`Space` → `Escape`) still keeps and
 * restores focus as expected.
 */
export function blurOnPointerPress(props?: PointerBlurProps) {
	let node: ViewRef | undefined;
	return {
		ref: (el: ViewRef) => {
			node = el;
			if (typeof props?.ref === "function") props.ref(el);
		},
		onMouseUp: (event: MouseEvent) => {
			node?.blur();
			props?.onMouseUp?.(event);
		},
	};
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
