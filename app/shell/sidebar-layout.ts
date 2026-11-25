import {
	type Accessor,
	effect,
	type GestureResponderEvent,
	type KeyEvent,
	reduceMotion,
	signal,
	type ViewRef,
} from "nsh";

import { MOTION } from "../ui/motion";
import {
	MAX_SIDEBAR_WIDTH,
	MIN_SIDEBAR_WIDTH,
	type SidebarSettingsStore,
} from "./sidebar-settings";

/** How far an arrow key moves the sidebar's edge, as in the WebUI. */
const RESIZE_STEP = 16;
/**
 * A drag collapses the sidebar a little below its smallest width, so that
 * pressing the handle at the minimum and jittering does not collapse it.
 */
const COLLAPSE_AT = MIN_SIDEBAR_WIDTH - 8;
/** Critically damped spring for sidebar collapse/expand, matching app motion. */
const COLLAPSE_TRANSITION = {
	type: "spring",
	...MOTION.spring.smooth,
} as const;
/** When the collapse has finished, a little after its transition. */
const SETTLE_MS = MOTION.duration.calm;

export interface SidebarLayout {
	collapsed: Accessor<boolean>;
	/**
	 * The collapse as it stands once its transition has finished: the
	 * header's actions wait for it while the sidebar opens.
	 */
	settledCollapsed: Accessor<boolean>;
	/** A drag is moving the edge. */
	resizing: Accessor<boolean>;
	width: Accessor<number>;
	setCollapsed(collapsed: boolean): void;
	/** The sidebar's frame, whose width the collapse animates. */
	bindAside(node: ViewRef): void;
	/** The main title bar, whose leading traffic-light inset animates in sync. */
	bindTitleBar(node: ViewRef): void;
	/** The resize handle's responder and keys. */
	handle: {
		onStartShouldSetResponder: () => boolean;
		onResponderGrant: (event: GestureResponderEvent) => boolean;
		onResponderMove: (event: GestureResponderEvent) => void;
		onResponderRelease: () => void;
		onResponderTerminate: () => void;
		onResponderTerminationRequest: () => boolean;
		onKeyDown: (event: KeyEvent) => void;
	};
}

/**
 * The sidebar's width, its drag and keyboard resizing and its collapse, as
 * the WebUI's `useSidebarLayout`: dragging below the smallest width
 * collapses it, and the collapse animates the width and the opacity.
 */
export function createSidebarLayout(
	settings: SidebarSettingsStore,
): SidebarLayout {
	const collapsed = signal(false);
	const settledCollapsed = signal(false);
	const resizing = signal(false);
	let aside: ViewRef | null = null;
	let titleBar: ViewRef | null = null;
	let drag: { startX: number; startWidth: number } | null = null;

	// Collapsing hides the header's actions at once; opening shows them once
	// the width has finished growing.
	effect(() => {
		const next = collapsed();
		const timer = setTimeout(
			() => settledCollapsed.set(next),
			reduceMotion() ? 0 : SETTLE_MS,
		);
		return () => clearTimeout(timer);
	});

	const setCollapsed = (next: boolean) => {
		if (collapsed() === next) return;
		if (!reduceMotion()) {
			aside?.animateLayout(COLLAPSE_TRANSITION);
			titleBar?.animateLayout(COLLAPSE_TRANSITION);
		}
		collapsed.set(next);
	};

	const endDrag = () => {
		if (!drag) return;
		drag = null;
		resizing.set(false);
		void settings.setWidth(settings.width());
	};

	return {
		collapsed,
		settledCollapsed,
		resizing,
		width: settings.width,
		setCollapsed,
		bindAside: (node) => {
			aside = node;
		},
		bindTitleBar: (node) => {
			titleBar = node;
		},
		handle: {
			onStartShouldSetResponder: () => !collapsed(),
			onResponderGrant: (event) => {
				drag = { startX: event.pageX, startWidth: settings.width() };
				resizing.set(true);
				// Keep the drag from the scroll views around.
				return true;
			},
			onResponderMove: (event) => {
				if (!drag) return;
				const width = drag.startWidth + (event.pageX - drag.startX);
				if (width <= COLLAPSE_AT) {
					settings.previewWidth(MIN_SIDEBAR_WIDTH);
					endDrag();
					setCollapsed(true);
					return;
				}
				settings.previewWidth(width);
			},
			onResponderRelease: endDrag,
			onResponderTerminate: endDrag,
			// The edge follows the pointer until it is released.
			onResponderTerminationRequest: () => false,
			onKeyDown: (event) => {
				if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
				// At the smallest width a further left collapses, as a drag does.
				if (
					event.key === "ArrowLeft" &&
					settings.width() <= MIN_SIDEBAR_WIDTH
				) {
					setCollapsed(true);
					return;
				}
				const delta = event.key === "ArrowRight" ? RESIZE_STEP : -RESIZE_STEP;
				void settings.setWidth(
					Math.min(
						MAX_SIDEBAR_WIDTH,
						Math.max(MIN_SIDEBAR_WIDTH, settings.width() + delta),
					),
				);
			},
		},
	};
}
