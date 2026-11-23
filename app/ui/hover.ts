import { type Accessor, signal } from "nsh";

/**
 * The pointer over a view, for the icons inside it: an icon draws in the
 * foreground it is given, not in the text color a `hover:` class sets.
 * Spread `props` on the view and read `hovered`.
 */
export function createHover() {
	const hovered = signal(false);
	return {
		hovered: hovered as Accessor<boolean>,
		props: {
			onMouseEnter: () => hovered.set(true),
			onMouseLeave: () => hovered.set(false),
		},
	};
}
