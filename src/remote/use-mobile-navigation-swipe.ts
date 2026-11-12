import { type TouchEvent, useRef } from "react";

const EDGE_WIDTH = 48;
const SWIPE_DISTANCE = 64;
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
};

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

	return {
		onTouchStartCapture(event: TouchEvent<HTMLDivElement>) {
			swipeRef.current = null;
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
				const inset = Number.parseFloat(
					getComputedStyle(currentTarget).paddingLeft,
				);
				if (
					layer ||
					touch.clientX > inset + EDGE_WIDTH ||
					!canStartEdgeSwipe(target, currentTarget)
				) {
					return;
				}
			}
			swipeRef.current = {
				id: touch.identifier,
				x: touch.clientX,
				y: touch.clientY,
				open,
			};
		},
		onTouchMoveCapture(event: TouchEvent<HTMLDivElement>) {
			const swipe = swipeRef.current;
			if (!swipe) return;
			const touch = event.touches[0];
			if (event.touches.length !== 1 || touch.identifier !== swipe.id) {
				swipeRef.current = null;
				return;
			}
			const x = (touch.clientX - swipe.x) * (swipe.open ? -1 : 1);
			const y = Math.abs(touch.clientY - swipe.y);
			if (
				x < -DIRECTION_SLOP ||
				(y > DIRECTION_SLOP && x < y * DIRECTION_RATIO)
			) {
				swipeRef.current = null;
			}
		},
		onTouchEndCapture(event: TouchEvent<HTMLDivElement>) {
			const swipe = swipeRef.current;
			swipeRef.current = null;
			if (!enabled || !swipe || swipe.open !== open || !event.cancelable)
				return;
			if (event.touches.length !== 0 || event.changedTouches.length !== 1)
				return;
			const touch = event.changedTouches[0];
			if (touch.identifier !== swipe.id) return;
			const x = (touch.clientX - swipe.x) * (open ? -1 : 1);
			const y = Math.abs(touch.clientY - swipe.y);
			if (x < SWIPE_DISTANCE || x < y * DIRECTION_RATIO) return;
			if (!open && window.getSelection()?.isCollapsed === false) return;
			// Don't let a swipe also click the row or control where it started.
			event.preventDefault();
			onOpenChange(!open);
		},
		onTouchCancelCapture() {
			swipeRef.current = null;
		},
	};
}
