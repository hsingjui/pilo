import {
	useEffect,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent,
} from "react";

import { cn } from "@/lib/utils";

export type ConversationOutlineMessage = {
	id: string;
	role: "user" | "assistant";
	text: string;
};

export type ConversationOutlineEntry = {
	key: string;
	title: string;
	preview: string;
	weight: 0 | 1 | 2 | 3;
};

const TICK_PITCH = 8;
const TICK_WIDTHS = [10, 13, 16, 20] as const;
const ACTIVE_TICK_WIDTH = 24;
const HOVER_WIDTH = 38;
const BELL_BASE_WIDTH = 15;
const BELL_SIGMA = 1.8;
const BELL_RADIUS = 4;
const TRACK_WIDTH = 50;
const HOVER_DELAY_MS = 200;

function plainText(value: string) {
	return value
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/[>*_~]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function truncate(value: string, length: number) {
	const points = Array.from(value);
	return points.length > length
		? `${points.slice(0, length).join("").trimEnd()}…`
		: value;
}

function weightForLength(length: number): 0 | 1 | 2 | 3 {
	if (length >= 3000) return 3;
	if (length >= 1500) return 2;
	if (length >= 700) return 1;
	return 0;
}

export function buildConversationOutline(
	messages: readonly ConversationOutlineMessage[],
): ConversationOutlineEntry[] {
	const entries: ConversationOutlineEntry[] = [];
	let current: ConversationOutlineEntry | undefined;
	let currentLength = 0;

	const closeRound = () => {
		if (current) current.weight = weightForLength(currentLength);
		current = undefined;
		currentLength = 0;
	};

	for (const message of messages) {
		const summary = plainText(message.text);
		if (message.role === "user" || !current) {
			closeRound();
			current = {
				key: message.id,
				title: truncate(summary || "未命名消息", 72),
				preview: message.role === "assistant" ? truncate(summary, 240) : "",
				weight: 0,
			};
			entries.push(current);
			currentLength = message.text.length;
			continue;
		}
		currentLength += message.text.length;
		if (!current.preview && message.role === "assistant") {
			current.preview = truncate(summary, 240);
		}
	}
	closeRound();
	return entries;
}

function tickWidth(resting: number, index: number, hoveredIndex: number) {
	if (hoveredIndex < 0) return resting;
	const distance = Math.abs(index - hoveredIndex);
	if (distance > BELL_RADIUS) return resting;
	const bell = Math.exp(-(distance * distance) / (2 * BELL_SIGMA * BELL_SIGMA));
	const target = BELL_BASE_WIDTH + (HOVER_WIDTH - BELL_BASE_WIDTH) * bell;
	return resting * (1 - bell) + target * bell;
}

export function ConversationOutlineRail({
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
				"group/outline pointer-events-none absolute inset-y-0 left-0 z-20 hidden w-[54px] items-center min-[860px]:flex",
				className,
			)}
		>
			<div className="pointer-events-auto max-h-1/2 overflow-y-auto py-2 pl-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
}
