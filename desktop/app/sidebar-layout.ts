import {
	type Accessor,
	effect,
	type GestureResponderEvent,
	type KeyEvent,
	signal,
	type ViewRef,
} from "nsh";

import {
	MAX_SIDEBAR_WIDTH,
	MIN_SIDEBAR_WIDTH,
	type SidebarSettingsStore,
} from "./sidebar-settings";

/** How far an arrow key moves the sidebar's edge, as in the Tauri app. */
const RESIZE_STEP = 16;
/**
 * A drag collapses the sidebar a little below its smallest width, so that
 * pressing the handle at the minimum and jittering does not collapse it.
 */
const COLLAPSE_AT = MIN_SIDEBAR_WIDTH - 8;
/** The Tauri sidebar's `transition-[width,opacity] duration-200 ease-out`. */
const COLLAPSE_TRANSITION = { type: "easeOut", duration: 200 } as const;
/** When the collapse has finished, a little after its transition. */
const SETTLE_MS = 220;

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
 * the Tauri app's `useSidebarLayout`: dragging below the smallest width
 * collapses it, and the collapse animates the width and the opacity.
 */
export function createSidebarLayout(
	settings: SidebarSettingsStore,
): SidebarLayout {
	const collapsed = signal(false);
	const settledCollapsed = signal(false);
	const resizing = signal(false);
	let aside: ViewRef | null = null;
	let drag: { startX: number; startWidth: number } | null = null;

	// Collapsing hides the header's actions at once; opening shows them once
	// the width has finished growing.
	effect(() => {
		const next = collapsed();
		const timer = setTimeout(() => settledCollapsed.set(next), SETTLE_MS);
		return () => clearTimeout(timer);
	});

	const setCollapsed = (next: boolean) => {
		if (collapsed() === next) return;
		aside?.animateLayout(COLLAPSE_TRANSITION);
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
