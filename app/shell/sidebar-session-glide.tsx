import {
	type Bounds,
	cleanup,
	context,
	createAnimatedValue,
	type JSX,
	type MouseEvent,
	reduceMotion,
	signal,
	View,
} from "nsh";
import { MOTION } from "../ui/motion";

export const SessionGlideContext = context<{
	show: (bounds: Bounds | null) => void;
	trackViewportRow?: (bounds: Bounds | null, event: MouseEvent) => void;
	leaveViewportRow?: () => void;
	dismiss: () => void;
} | null>(null);

/** One hover highlight that glides between rows without moving the selection. */
export function SessionGlide(props: {
	children?: JSX.Element;
	viewport?: (onScroll: () => void) => JSX.Element;
}) {
	const top = createAnimatedValue(0);
	const opacity = createAnimatedValue(0);
	const height = signal(0);
	const viewport = props.viewport;
	let hovering = false;
	let viewportTop: number | null = null;
	let viewportRowTop: number | null = null;
	let rowLeaveTimer: ReturnType<typeof setTimeout> | undefined;

	const cancelRowLeave = () => {
		clearTimeout(rowLeaveTimer);
		rowLeaveTimer = undefined;
	};
	const fadeTo = (target: number) => {
		if (reduceMotion()) opacity.set(target);
		else {
			void opacity.timing(target, {
				duration: MOTION.duration.tactile,
				easing: MOTION.easing.standardTuple,
			});
		}
	};
	const showAt = (y: number, rowHeight: number) => {
		height.set(rowHeight);
		if (hovering) {
			if (reduceMotion()) top.set(y);
			else void top.spring(y, MOTION.spring.crisp);
			return;
		}
		// Position the first highlight while hidden, even if it was still fading out.
		opacity.set(0);
		top.set(y);
		hovering = true;
		fadeTo(1);
	};
	const fadeOut = () => {
		cancelRowLeave();
		viewportRowTop = null;
		if (!hovering) return;
		hovering = false;
		void top.stop();
		fadeTo(0);
	};
	const glide = {
		show: (bounds: Bounds | null) => {
			if (bounds) showAt(bounds.origin.y, bounds.size.height);
		},
		trackViewportRow: viewport
			? (bounds: Bounds | null, event: MouseEvent) => {
					if (!bounds || viewportTop === null) return;
					cancelRowLeave();
					// A virtual row's layout origin is relative to its recycled cell.
					const y = event.pagePosition.y - event.position.y - viewportTop;
					const rowHeight = bounds.size.height;
					if (
						viewportRowTop !== null &&
						Math.abs(viewportRowTop - y) < 0.5 &&
						height() === rowHeight
					) {
						return;
					}
					viewportRowTop = y;
					showAt(y, rowHeight);
				}
			: undefined,
		leaveViewportRow: viewport
			? () => {
					if (!hovering) return;
					cancelRowLeave();
					// Keep the glide alive long enough to cross the gap between rows.
					rowLeaveTimer = setTimeout(fadeOut, MOTION.duration.tactile);
				}
			: undefined,
		dismiss: () => {
			cancelRowLeave();
			hovering = false;
			opacity.set(0);
			void top.stop();
		},
	};
	const onViewportScroll = () => {
		viewportRowTop = null;
		if (hovering) glide.dismiss();
	};
	cleanup(() => {
		cancelRowLeave();
		void top.stop();
		void opacity.stop();
	});
	return (
		<View
			class={
				viewport
					? "relative min-h-0 w-full min-w-0 flex-1 overflow-hidden"
					: "relative w-full min-w-0 gap-(--pilo-sidebar-session-gap)"
			}
			onMouseEnter={
				viewport
					? ({ pagePosition, position }) => {
							viewportTop = pagePosition.y - position.y;
						}
					: undefined
			}
			onMouseLeave={() => {
				viewportTop = null;
				fadeOut();
			}}
		>
			<View
				class={`pointer-events-none absolute top-0 rounded-md bg-sidebar-hover ${viewport ? "right-2.5 left-1.5" : "inset-x-0"}`}
				style={{
					height: height(),
					opacity,
					transform: [{ translateY: top }],
				}}
			/>
			<SessionGlideContext.Provider value={glide}>
				{viewport ? viewport(onViewportScroll) : props.children}
			</SessionGlideContext.Provider>
		</View>
	);
}
