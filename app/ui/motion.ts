import {
	type Accessor,
	cleanup,
	createMotion,
	effect,
	reduceMotion,
	signal,
	untracked,
	type MotionSpring,
	type ViewStyle,
} from "nsh";
import type { ScrollbarMotion } from "nsh/base";

/**
 * Single motion language for Pilo (desktop + Remote WebUI).
 *
 * Keeps every state change on the same curves and rhythm:
 * - tactile: instant-feeling hover / press / focus / row highlight
 * - surface: crisp anchored popovers, menus, selects, tooltips
 * - modal: quiet dialog / command palette transitions
 * - spring.crisp: switches, tabs, checkboxes, micro-confirmations
 * - spring.smooth: collapsible reveals, sidebar, drawers, bottom sheets
 */
export const MOTION = {
	duration: {
		tactile: 110,
		surfaceIn: 150,
		surfaceOut: 100,
		modalIn: 180,
		modalOut: 130,
		view: 140,
		calm: 200,
	},
	easing: {
		standard: "cubic-bezier(0.2, 0, 0, 1)" as const,
		standardTuple: [0.2, 0, 0, 1] as [number, number, number, number],
		exit: "cubic-bezier(0.4, 0, 1, 1)" as const,
		exitTuple: [0.4, 0, 1, 1] as [number, number, number, number],
		springCrispCss: "spring(480, 36)" as const,
		springSmoothCss: "spring(360, 36)" as const,
	},
	spring: {
		crisp: { stiffness: 480, damping: 36, mass: 1 } as MotionSpring,
		smooth: { stiffness: 360, damping: 36, mass: 1 } as MotionSpring,
	},
	scrollbar: {
		enter: 120,
		exit: 260,
		idle: 1200,
	} as ScrollbarMotion,
} as const;

/** Shared tactile transition for hover, focus ring, press and subtle reveals. */
export function tactileTransition(properties: string): ViewStyle {
	if (reduceMotion()) {
		return { transitionProperty: "none", transitionDuration: 0 };
	}
	return {
		transitionProperty: properties,
		transitionDuration: MOTION.duration.tactile,
		transitionTimingFunction: MOTION.easing.standard,
	};
}

/** Shared view/surface transition with custom duration (defaults to view = 140ms). */
export function viewTransition(
	properties: string,
	duration: number = MOTION.duration.view,
): ViewStyle {
	if (reduceMotion()) {
		return { transitionProperty: "none", transitionDuration: 0 };
	}
	return {
		transitionProperty: properties,
		transitionDuration: duration,
		transitionTimingFunction: MOTION.easing.standard,
	};
}

/** Physical spring transition driven natively on the UI thread. */
export function springTransition(
	properties: string,
	kind: "crisp" | "smooth" = "crisp",
): ViewStyle {
	if (reduceMotion()) {
		return { transitionProperty: "none", transitionDuration: 0 };
	}
	return {
		transitionProperty: properties,
		transitionTimingFunction:
			kind === "crisp"
				? MOTION.easing.springCrispCss
				: MOTION.easing.springSmoothCss,
	};
}

/** Smooth single-icon rotation for disclosure chevrons (no icon swapping). */
export function chevronRotateStyle(
	open: boolean,
	closedDeg = 0,
	openDeg = 90,
): ViewStyle {
	return {
		...springTransition("transform", "crisp"),
		transform: [{ rotate: open ? openDeg : closedDeg }],
	};
}

/** Props for nsh Collapsible reveal, respecting reduced motion. */
export function collapsibleRevealProps(
	spring: MotionSpring = MOTION.spring.smooth,
) {
	return {
		reveal: !reduceMotion(),
		revealSpring: spring,
	} as const;
}

/**
 * Anchored floating surface enter/exit styles (Popover, Menu, Select, HoverCard).
 * Enters with a subtle scale + opacity settle; exits faster so it never lingers.
 */
export function popupMotionStyles(options?: {
	scale?: number;
	translateY?: number;
}): {
	popupStyle: ViewStyle;
	popupStartingStyle: ViewStyle;
	popupEndingStyle: ViewStyle;
} {
	if (reduceMotion()) {
		return {
			popupStyle: {
				transitionProperty: "opacity",
				transitionDuration: 80,
				transitionTimingFunction: MOTION.easing.standard,
			},
			popupStartingStyle: { opacity: 0 },
			popupEndingStyle: {
				opacity: 0,
				transitionDuration: 60,
				transitionTimingFunction: MOTION.easing.exit,
			},
		};
	}
	const scale = options?.scale ?? 0.97;
	const translateY = options?.translateY ?? 0;
	const startTransform =
		translateY !== 0 ? [{ scale }, { translateY }] : [{ scale }];
	return {
		popupStyle: {
			transitionProperty: "opacity, transform",
			transitionDuration: MOTION.duration.surfaceIn,
			transitionTimingFunction: MOTION.easing.standard,
		},
		popupStartingStyle: {
			opacity: 0,
			transform: startTransform,
		},
		popupEndingStyle: {
			opacity: 0,
			transform: [{ scale: 0.98 }],
			transitionDuration: MOTION.duration.surfaceOut,
			transitionTimingFunction: MOTION.easing.exit,
		},
	};
}

/** Tooltip enter/exit styles (same family as anchored popups, lighter and faster). */
export function tooltipMotionStyles(): {
	style: ViewStyle;
	startingStyle: ViewStyle;
	endingStyle: ViewStyle;
} {
	if (reduceMotion()) {
		return {
			style: {
				transitionProperty: "opacity",
				transitionDuration: 70,
				transitionTimingFunction: MOTION.easing.standard,
			},
			startingStyle: { opacity: 0 },
			endingStyle: {
				opacity: 0,
				transitionDuration: 60,
				transitionTimingFunction: MOTION.easing.exit,
			},
		};
	}
	return {
		style: {
			transitionProperty: "opacity, transform",
			transitionDuration: MOTION.duration.tactile,
			transitionTimingFunction: MOTION.easing.standard,
		},
		startingStyle: {
			opacity: 0,
			transform: [{ scale: 0.97 }],
		},
		endingStyle: {
			opacity: 0,
			transform: [{ scale: 0.98 }],
			transitionDuration: MOTION.duration.surfaceOut,
			transitionTimingFunction: MOTION.easing.exit,
		},
	};
}

/** Toast enter/exit/swipe props aligned with ToastStack's native spring layout. */
export function toastMotionProps(): {
	style: ViewStyle;
	startingClass: string;
	endingClass: string;
	swipingClass: string;
} {
	if (reduceMotion()) {
		return {
			style: {
				transitionProperty: "opacity",
				transitionDuration: 90,
				transitionTimingFunction: MOTION.easing.standard,
			},
			startingClass: "opacity-0",
			endingClass: "opacity-0",
			swipingClass: "transition-none",
		};
	}
	return {
		style: {
			transitionProperty: "opacity, transform",
			transitionDuration: MOTION.duration.modalIn,
			transitionTimingFunction: MOTION.easing.standard,
		},
		startingClass: "opacity-0 -translate-y-2 scale-[0.97]",
		endingClass: "opacity-0 -translate-y-1 scale-[0.97] duration-[130ms]",
		swipingClass: "transition-none",
	};
}

/**
 * Keeps dialog content mounted while its close animation finishes,
 * clearing it in `onClose` so closing dialogs never flash empty.
 */
export function useMountedDialog(open: Accessor<boolean>) {
	const mounted = signal(untracked(open));
	effect(() => {
		if (open()) mounted.set(true);
	});
	return {
		mounted,
		onClose: () => {
			if (!open()) mounted.set(false);
		},
	};
}

/**
 * Quiet opacity fade-in for keep-alive overlays/panels when they become active,
 * without adding layout displacement or delaying pointer interaction.
 */
export function useEnterFade(
	active: Accessor<boolean>,
	duration: number = MOTION.duration.view,
) {
	const motion = createMotion();
	let wasActive = untracked(active);
	effect(() => {
		const next = active();
		if (next && !wasActive && !reduceMotion()) {
			void motion.play({
				keyframes: { opacity: [0.01, 1] },
				duration,
				easing: MOTION.easing.standardTuple,
			});
		}
		wasActive = next;
	});
	cleanup(() => motion.stop());
	return motion;
}

/** Subtle error-shake motion for invalid form inputs (no-op under reduceMotion). */
export function createShakeMotion() {
	return createMotion();
}

export function playErrorShake(motion: ReturnType<typeof createMotion>) {
	if (reduceMotion()) return;
	void motion.play({
		keyframes: [
			{ offset: 0, translateX: 0 },
			{ offset: 0.2, translateX: -4 },
			{ offset: 0.45, translateX: 4 },
			{ offset: 0.7, translateX: -2.5 },
			{ offset: 0.88, translateX: 1.5 },
			{ offset: 1, translateX: 0 },
		],
		duration: 260,
		easing: MOTION.easing.standardTuple,
	});
}
