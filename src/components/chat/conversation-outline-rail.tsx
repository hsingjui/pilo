import {
	memo,
	useEffect,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent,
} from "react";

import { cn } from "@/lib/utils";

import type { ConversationOutlineEntry } from "@/lib/conversation-outline";

const TICK_PITCH = 8;
const TICK_WIDTHS = [10, 13, 16, 20] as const;
const ACTIVE_TICK_WIDTH = 24;
const HOVER_WIDTH = 38;
const BELL_BASE_WIDTH = 15;
const BELL_SIGMA = 1.8;
const BELL_RADIUS = 4;
const ACTIVE_BAR_OVERHANG = ACTIVE_TICK_WIDTH - Math.max(...TICK_WIDTHS);
const TRACK_WIDTH = HOVER_WIDTH + ACTIVE_BAR_OVERHANG;
const TRACK_INSET = 8;
const RAIL_WIDTH = TRACK_WIDTH + TRACK_INSET;
const HOVER_DELAY_MS = 200;

function tickWidth(resting: number, index: number, hoveredIndex: number) {
	if (hoveredIndex < 0) return resting;
	const distance = Math.abs(index - hoveredIndex);
	if (distance > BELL_RADIUS) return resting;
	const bell = Math.exp(-(distance * distance) / (2 * BELL_SIGMA * BELL_SIGMA));
	const target = BELL_BASE_WIDTH + (HOVER_WIDTH - BELL_BASE_WIDTH) * bell;
	return resting * (1 - bell) + target * bell;
}

export const ConversationOutlineRail = memo(function ConversationOutlineRail({
	entries,
	activeIndex,
	onJumpToRound,
	className,
}: {
	entries: readonly ConversationOutlineEntry[];
	activeIndex: number;
	onJumpToRound: (index: number) => void;
	className?: string;
}) {
	const railRef = useRef<HTMLElement>(null);
	const openTimerRef = useRef<number | null>(null);
	const [hoveredIndex, setHoveredIndex] = useState(-1);
	const [hoverCard, setHoverCard] = useState<{
		index: number;
		top: number;
	} | null>(null);
	const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
	const tabbableIndex = focusedIndex ?? Math.max(activeIndex, 0);

	useEffect(
		() => () => {
			if (openTimerRef.current !== null)
				window.clearTimeout(openTimerRef.current);
		},
		[],
	);

	const widths = useMemo(
		() =>
			entries.map((entry, index) =>
				tickWidth(TICK_WIDTHS[entry.weight], index, hoveredIndex),
			),
		[entries, hoveredIndex],
	);

	if (entries.length < 2) return null;

	const handleKeyDown = (
		event: KeyboardEvent<HTMLButtonElement>,
		index: number,
	) => {
		let nextIndex = -1;
		if (event.key === "ArrowDown")
			nextIndex = Math.min(index + 1, entries.length - 1);
		if (event.key === "ArrowUp") nextIndex = Math.max(index - 1, 0);
		if (event.key === "Home") nextIndex = 0;
		if (event.key === "End") nextIndex = entries.length - 1;
		if (nextIndex >= 0) {
			event.preventDefault();
			setFocusedIndex(nextIndex);
			railRef.current
				?.querySelector<HTMLButtonElement>(
					`[data-outline-index="${nextIndex}"]`,
				)
				?.focus();
			return;
		}
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			onJumpToRound(index);
		}
	};

	return (
		<nav
			ref={railRef}
			aria-label="消息导航"
			className={cn(
				"group/outline pointer-events-none absolute inset-y-0 left-0 z-20 hidden items-center min-[860px]:flex",
				className,
			)}
			style={{ width: RAIL_WIDTH }}
		>
			<div
				className="pointer-events-auto max-h-1/2 overflow-y-auto py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
				style={{ paddingLeft: TRACK_INSET }}
			>
				<div className="relative" style={{ width: TRACK_WIDTH }}>
					<ol className="m-0 flex list-none flex-col p-0">
						{entries.map((entry, index) => (
							<li key={entry.key} className="contents">
								<button
									type="button"
									data-outline-index={index}
									tabIndex={index === tabbableIndex ? 0 : -1}
									aria-current={index === activeIndex ? "true" : undefined}
									aria-label={entry.title}
									className="group/tick flex w-full items-center outline-hidden"
									style={{ height: TICK_PITCH }}
									onFocus={() => setFocusedIndex(index)}
									onKeyDown={(event) => handleKeyDown(event, index)}
									onClick={() => onJumpToRound(index)}
									onPointerEnter={(event) => {
										setHoveredIndex(index);
										if (openTimerRef.current !== null)
											window.clearTimeout(openTimerRef.current);
										const rail = railRef.current;
										if (!rail) return;
										const tickRect =
											event.currentTarget.getBoundingClientRect();
										const railRect = rail.getBoundingClientRect();
										const rawTop =
											tickRect.top - railRect.top + tickRect.height / 2;
										const top = Math.max(
											72,
											Math.min(rawTop, railRect.height - 72),
										);
										openTimerRef.current = window.setTimeout(
											() => setHoverCard({ index, top }),
											HOVER_DELAY_MS,
										);
									}}
									onPointerLeave={() => {
										setHoveredIndex(-1);
										if (openTimerRef.current !== null)
											window.clearTimeout(openTimerRef.current);
										openTimerRef.current = null;
										setHoverCard(null);
									}}
								>
									<span
										aria-hidden="true"
										className="h-[2px] rounded-full bg-muted-foreground/45 transition-[background-color,width] duration-150 ease-out group-hover/tick:bg-muted-foreground/80 group-focus-visible/tick:bg-foreground/80"
										style={{ width: widths[index] }}
									/>
								</button>
							</li>
						))}
					</ol>
					{activeIndex >= 0 ? (
						<span
							aria-hidden="true"
							className="pointer-events-none absolute left-0 top-0 h-[2px] rounded-full bg-foreground/80 transition-[transform,width] duration-150 ease-out"
							style={{
								width: Math.max(
									ACTIVE_TICK_WIDTH,
									(widths[activeIndex] ?? ACTIVE_TICK_WIDTH) + 4,
								),
								transform: `translateY(${activeIndex * TICK_PITCH + 3}px)`,
							}}
						/>
					) : null}
				</div>
			</div>

			{hoverCard ? (
				<div
					className="pointer-events-none absolute left-[54px] w-72 -translate-y-1/2 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg"
					style={{ top: hoverCard.top }}
				>
					<div className="line-clamp-3 text-[13px] font-medium leading-snug">
						{entries[hoverCard.index]?.title}
					</div>
					<div className="mt-1.5 line-clamp-6 text-xs leading-relaxed text-muted-foreground">
						{entries[hoverCard.index]?.preview || "还没有 Pi 回复。"}
					</div>
				</div>
			) : null}
		</nav>
	);
});
