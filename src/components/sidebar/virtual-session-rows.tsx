import {
	useLayoutEffect,
	useRef,
	useState,
	type ReactNode,
	type RefObject,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { SidebarSession } from "./types";

const SESSION_ROW_ESTIMATE = 30;

export function VirtualSessionRows({
	sessions,
	scrollViewportRef,
	renderSession,
}: {
	sessions: SidebarSession[];
	scrollViewportRef: RefObject<HTMLDivElement | null>;
	renderSession: (session: SidebarSession) => ReactNode;
}) {
	const listRef = useRef<HTMLDivElement>(null);
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
	});

	return (
		<div
			ref={listRef}
			className="relative w-full min-w-0 overflow-hidden"
			style={{ height: `${virtualizer.getTotalSize()}px` }}
		>
			{virtualizer.getVirtualItems().map((item) => {
				const session = sessions[item.index];
				if (!session) return null;
				return (
					<div
						key={item.key}
						data-index={item.index}
						ref={virtualizer.measureElement}
						className="absolute left-0 top-0 w-full min-w-0 overflow-hidden"
						style={{
							transform: `translateY(${item.start - scrollMargin}px)`,
						}}
					>
						{renderSession(session)}
					</div>
				);
			})}
		</div>
	);
}
