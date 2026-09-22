import {
	memo,
	useCallback,
	useLayoutEffect,
	useRef,
	useState,
	type ReactNode,
	type RefObject,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { SessionRowHighlightBlock, useSessionRowGlide } from "./rows";
import type { SidebarSession } from "./types";

const SESSION_ROW_ESTIMATE = 30;

export const VirtualSessionRows = memo(function VirtualSessionRows({
	sessions,
	scrollViewportRef,
	renderSession,
}: {
	sessions: SidebarSession[];
	scrollViewportRef: RefObject<HTMLDivElement | null>;
	renderSession: (session: SidebarSession) => ReactNode;
}) {
	const listRef = useRef<HTMLDivElement>(null);
	const { containerRef, highlight, onPointerOver, onPointerLeave } =
		useSessionRowGlide();
	const [scrollMargin, setScrollMargin] = useState(0);
	useLayoutEffect(() => {
		const list = listRef.current;
		const viewport = scrollViewportRef.current;
		if (!list || !viewport) return;
		const listRect = list.getBoundingClientRect();
		const viewportRect = viewport.getBoundingClientRect();
		setScrollMargin(listRect.top - viewportRect.top + viewport.scrollTop);
	}, [scrollViewportRef, sessions.length]);

	/* oxlint-disable-next-line react/incompatible-library -- TanStack Virtual intentionally owns imperative measurement for long session lists. */
	const virtualizer = useVirtualizer({
		count: sessions.length,
		getScrollElement: () => scrollViewportRef.current,
		estimateSize: () => SESSION_ROW_ESTIMATE,
		overscan: 8,
		scrollMargin,
		getItemKey: (index) => sessions[index]?.id ?? index,
		useAnimationFrameWithResizeObserver: true,
		// Keep scroll-offset updates out of React when the visible range has not
		// changed. The virtualizer writes transforms/size directly to the DOM.
		directDomUpdates: true,
		useFlushSync: false,
	});
	const setListRef = useCallback(
		(node: HTMLDivElement | null) => {
			listRef.current = node;
			containerRef.current = node;
			virtualizer.containerRef(node);
		},
		[virtualizer, containerRef],
	);

	return (
		<div
			ref={setListRef}
			className="group/glide relative w-full min-w-0 overflow-hidden"
			onPointerOver={onPointerOver}
			onPointerLeave={onPointerLeave}
		>
			<SessionRowHighlightBlock highlight={highlight} />
			{virtualizer.getVirtualItems().map((item) => {
				const session = sessions[item.index];
				if (!session) return null;
				return (
					<div
						key={item.key}
						data-index={item.index}
						ref={virtualizer.measureElement}
						className="absolute left-0 top-0 w-full min-w-0 overflow-hidden"
					>
						{renderSession(session)}
					</div>
				);
			})}
		</div>
	);
});
