import {
	type TouchEvent as ReactTouchEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

const SWIPE_DISTANCE = 64;
const CLAIM_DISTANCE = 4;
const DIRECTION_SLOP = 12;
const DIRECTION_RATIO = 1.5;
const EDITABLE = "input, textarea, select, [contenteditable]";
const LAYER =
	'[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

type Swipe = {
	id: number;
	x: number;
	y: number;
	open: boolean;
	claimed: boolean;
	openingOffset?: string;
};

type OpeningDrag =
	| { phase: "dragging" | "canceling"; offset: string }
	| { phase: "opening"; offset?: string };

function canStartEdgeSwipe(target: Element, workspace: HTMLElement) {
	if (!workspace.contains(target) || target.closest("button, a[href]")) {
		return false;
	}
	for (
		let node: Element | null = target;
		node && node !== workspace;
		node = node.parentElement
	) {
		if (
			node.scrollWidth > node.clientWidth &&
			/^(auto|scroll)$/.test(getComputedStyle(node).overflowX)
		) {
			return false;
		}
	}
	return true;
}

export function useMobileNavigationSwipe(
	enabled: boolean,
	open: boolean,
	onOpenChange: (open: boolean) => void,
) {
	const swipeRef = useRef<Swipe | null>(null);
	const previewRef = useRef<HTMLDivElement>(null);
	const attachPreview = useCallback((element: HTMLDivElement | null) => {
		previewRef.current = element;
		const offset = swipeRef.current?.openingOffset;
		if (element && offset) element.style.transform = `translateX(${offset})`;
	}, []);
	const [openingDrag, setOpeningDrag] = useState<OpeningDrag | null>(null);
	if (openingDrag && (!enabled || open !== (openingDrag.phase === "opening"))) {
		setOpeningDrag(null);
	}

	const cancelSwipe = useCallback(() => {
		const offset = swipeRef.current?.openingOffset;
		swipeRef.current = null;
		if (offset) {
			setOpeningDrag(
				window.matchMedia("(prefers-reduced-motion: reduce)").matches
					? null
					: { phase: "canceling", offset },
			);
		}
	}, []);

	useEffect(() => {
		if (!enabled) return;

		function onTouchMove(event: TouchEvent) {
			const swipe = swipeRef.current;
			if (!swipe) return;
			const touch = event.touches[0];
			if (event.touches.length !== 1 || touch.identifier !== swipe.id) {
				cancelSwipe();
				return;
			}
			const x = (touch.clientX - swipe.x) * (swipe.open ? -1 : 1);
			const y = Math.abs(touch.clientY - swipe.y);
			if (
				!swipe.openingOffset &&
				(x < -DIRECTION_SLOP || (y > DIRECTION_SLOP && x < y * DIRECTION_RATIO))
			) {
				cancelSwipe();
				return;
			}
			if (
				!swipe.claimed &&
				!(event.cancelable && x >= CLAIM_DISTANCE && x >= y * DIRECTION_RATIO)
			) {
				return;
			}
			if (event.cancelable) event.preventDefault();
			swipe.claimed = true;
			if (!swipe.open) {
				const offset = `clamp(-100%, calc(${Math.max(0, x)}px - 100%), 0px)`;
				if (!swipe.openingOffset) setOpeningDrag({ phase: "dragging", offset });
				swipe.openingOffset = offset;
				// Keep touchmove out of React rendering once the preview is mounted.
				if (previewRef.current)
					previewRef.current.style.transform = `translateX(${offset})`;
			}
		}

		// React's touchmove is passive; document capture also covers the drawer portal.
		document.addEventListener("touchmove", onTouchMove, {
			capture: true,
			passive: false,
		});
		return () => {
			document.removeEventListener("touchmove", onTouchMove, true);
			swipeRef.current = null;
		};
	}, [cancelSwipe, enabled]);

	const handlers = {
		onTouchStartCapture(event: ReactTouchEvent<HTMLDivElement>) {
			cancelSwipe();
			if (!enabled || event.touches.length !== 1) return;
			const { target, currentTarget } = event;
			if (!(target instanceof Element) || target.closest(EDITABLE)) return;

			const touch = event.touches[0];
			const layer = target.closest(LAYER);
			if (open) {
				// Radix portals bubble through the React tree, including unrelated menus.
				const surface = target.closest(
					'[data-mobile-navigation-swipe][data-state="open"]',
				);
				if (!surface || (layer && layer !== surface)) return;
			} else {
				if (
					layer ||
					touch.clientX > (currentTarget.clientWidth * 2) / 3 ||
					!canStartEdgeSwipe(target, currentTarget) ||
					window.getSelection()?.isCollapsed === false
				) {
					return;
				}
			}
			swipeRef.current = {
				id: touch.identifier,
				x: touch.clientX,
				y: touch.clientY,
				open,
				claimed: false,
			};
		},
		onTouchEndCapture(event: ReactTouchEvent<HTMLDivElement>) {
			const swipe = swipeRef.current;
			if (!swipe) return;
			const touch = event.changedTouches[0];
			if (
				!enabled ||
				swipe.open !== open ||
				(!swipe.claimed && !event.cancelable) ||
				event.touches.length !== 0 ||
				event.changedTouches.length !== 1 ||
				touch.identifier !== swipe.id
			) {
				cancelSwipe();
				return;
			}
			const x = (touch.clientX - swipe.x) * (open ? -1 : 1);
			const y = Math.abs(touch.clientY - swipe.y);
			if (
				x < SWIPE_DISTANCE ||
				(!swipe.openingOffset && x < y * DIRECTION_RATIO) ||
				(!open && window.getSelection()?.isCollapsed === false)
			) {
				cancelSwipe();
				return;
			}
			swipeRef.current = null;
			// Don't let a swipe also click the row or control where it started.
			if (event.cancelable) event.preventDefault();
			if (!open)
				setOpeningDrag({ phase: "opening", offset: swipe.openingOffset });
			onOpenChange(!open);
		},
		onTouchCancelCapture: cancelSwipe,
	};

	return {
		handlers,
		motion: {
			openingDrag,
			attachPreview,
			finishCancel: () =>
				setOpeningDrag((drag) => (drag?.phase === "canceling" ? null : drag)),
		},
	};
}

export type MobileNavigationMotion = ReturnType<
	typeof useMobileNavigationSwipe
>["motion"];
