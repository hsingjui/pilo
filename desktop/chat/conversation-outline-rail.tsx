import {
	batch,
	computed,
	effect,
	platform,
	signal,
	Text,
	token,
	untracked,
	View,
	type KeyEvent,
	type ViewRef,
	type WheelEvent,
} from "nsh";
import { Tooltip } from "nsh/base";

import type { ConversationOutlineEntry } from "@shared/chat/conversation-outline";
import { t } from "../app/i18n";
import { focusRingStyle } from "../ui/focus-ring-style";
import { styleVar } from "../ui/theme-style";
import {
	conversationColumnGeometry,
	ConversationColumnLayout,
} from "./conversation-column";
import { chatPx, DEFAULT_CHAT_REM } from "./layout";

const MIN_PANE_WIDTH = 35 * DEFAULT_CHAT_REM;
const TICK_PITCH = 8;
const TICK_HEIGHT = 2.5;
const TICK_WIDTHS = [10, 13, 16, 20] as const;
const ACTIVE_TICK_WIDTH = 24;
const ACTIVE_OVERHANG = 4;
const TRACK_INSET = 8;
const HOVER_WIDTH = 38;
const TRACK_WIDTH = HOVER_WIDTH + ACTIVE_OVERHANG;
const BELL_BASE_WIDTH = 15;
const BELL_SIGMA = 1.8;
const BELL_RADIUS = 4;
const NAVIGATION_KEYS = [
	"arrowdown",
	"arrowup",
	"home",
	"end",
	"enter",
	"space",
];

function tickWidth(resting: number, index: number, hoveredIndex: number) {
	if (hoveredIndex < 0) return resting;
	const distance = Math.abs(index - hoveredIndex);
	if (distance > BELL_RADIUS) return resting;
	const bell = Math.exp(-(distance * distance) / (2 * BELL_SIGMA * BELL_SIGMA));
	const target = BELL_BASE_WIDTH + (HOVER_WIDTH - BELL_BASE_WIDTH) * bell;
	return resting * (1 - bell) + target * bell;
}

export interface ConversationOutlineRailProps {
	entries: () => readonly ConversationOutlineEntry[];
	activeIndex: () => number;
	onJump: (index: number) => void;
}

export function ConversationOutlineRail(props: ConversationOutlineRailProps) {
	if (!platform.desktop) return null;

	const layout = ConversationColumnLayout();
	const viewport = signal({ width: 0, height: 0 });
	const offset = signal(0);
	const hoveredRow = signal(-1);
	const focused = signal<number | null>(null);
	const focusTarget = signal<number | null>(null);
	const count = computed(() => props.entries().length);
	const trackWidth = computed(() => {
		const { width } = viewport();
		if (width < MIN_PANE_WIDTH) return 0;
		const { widthPercent, maxWidth, paddingHorizontal } =
			conversationColumnGeometry(layout().claude, layout().narrow);
		const columnWidth = Math.min((width * widthPercent) / 100, maxWidth);
		const gutter = (width - columnWidth) / 2 + paddingHorizontal;
		return Math.min(TRACK_WIDTH, gutter - TRACK_INSET);
	});
	const capacity = computed(() =>
		Math.max(0, Math.floor((viewport().height / 2 - 16) / TICK_PITCH)),
	);
	const showRail = computed(() => trackWidth() > 0 && capacity() > 0);
	const maxStart = computed(() => Math.max(0, count() - capacity()));
	const start = computed(() =>
		Math.min(maxStart(), Math.round(offset() / TICK_PITCH)),
	);

	// Keep real press targets outside Scroll, which has swallowed child presses
	// on macOS. A contiguous window keeps every round reachable without sampling.
	const displayed = computed(() =>
		props
			.entries()
			.slice(start(), start() + capacity())
			.map((entry, row) => ({ entry, index: start() + row })),
	);
	const hoveredIndex = () => (hoveredRow() < 0 ? -1 : start() + hoveredRow());
	const activeTick = computed(() => displayed()[props.activeIndex() - start()]);
	const showActiveTick = computed(() => activeTick() !== undefined);
	const widthAt = (tick: { entry: ConversationOutlineEntry; index: number }) =>
		tickWidth(TICK_WIDTHS[tick.entry.weight], tick.index, hoveredIndex());
	const activeWidth = () => {
		const tick = activeTick();
		return Math.min(
			trackWidth(),
			Math.max(ACTIVE_TICK_WIDTH, tick ? widthAt(tick) + ACTIVE_OVERHANG : 0),
		);
	};
	const tabStop = computed(() => {
		const requested = focusTarget() ?? focused() ?? props.activeIndex();
		return Math.max(
			start(),
			Math.min(requested, start() + displayed().length - 1),
		);
	});

	const reveal = (index: number, slots: number) => {
		if (index < start()) offset.set(index * TICK_PITCH);
		else if (index >= start() + slots)
			offset.set((index - slots + 1) * TICK_PITCH);
	};
	effect(() => {
		const active = props.activeIndex();
		const slots = capacity();
		const limit = maxStart() * TICK_PITCH;
		if (slots === 0) return;
		untracked(() => {
			offset.set(Math.min(offset(), limit));
			if (active >= 0) reveal(focusTarget() ?? active, slots);
		});
	});

	const onWheel = (event: WheelEvent) => {
		if (event.modifiers.control || event.delta.y === 0) return;
		const delta =
			event.delta.y * (event.deltaMode === "lines" ? TICK_PITCH : 1);
		offset.set(
			Math.max(0, Math.min(maxStart() * TICK_PITCH, offset() + delta)),
		);
	};
	const onKeyDown = (event: KeyEvent, index: number) => {
		const { alt, control, platform, shift } = event.modifiers;
		if (alt || control || platform || shift) return;
		if (event.key === "Enter" || event.key === " ") {
			if (!event.repeat) props.onJump(index);
			return;
		}
		let next = index;
		if (event.key === "ArrowDown") next = Math.min(index + 1, count() - 1);
		if (event.key === "ArrowUp") next = Math.max(index - 1, 0);
		if (event.key === "Home") next = 0;
		if (event.key === "End") next = count() - 1;
		if (next === index) return;
		batch(() => {
			reveal(next, capacity());
			focusTarget.set(next);
		});
	};

	return (
		<View
			class="absolute inset-0 items-start justify-center"
			style={{ pointerEvents: "box-none", zIndex: 20 }}
			onLayout={({ bounds }) => viewport.set(bounds.size)}
		>
			{() =>
				showRail() && (
					<View
						testID="chat-outline-rail"
						accessibilityLabel={t("chat.messageNavigation")}
						role="navigation"
						class="relative shrink-0"
						style={{ marginLeft: TRACK_INSET, width: trackWidth() }}
						onWheel={maxStart() > 0 ? onWheel : undefined}
						onMouseMove={({ position }) =>
							hoveredRow.set(Math.floor(position.y / TICK_PITCH))
						}
						onMouseLeave={() => hoveredRow.set(-1)}
					>
						<Each of={displayed()} key="index">
							{(tick) => {
								let button: ViewRef | undefined;
								const index = () => tick().index;
								effect(() => {
									if (focusTarget() === index()) button?.focus();
								});
								return (
									<View
										testID={`chat-outline-tick-${index()}`}
										role="button"
										accessibilityLabel={tick().entry.title}
										accessibilityState={{
											current: index() === props.activeIndex(),
										}}
										focusable={index() === tabStop()}
										captureKeys={NAVIGATION_KEYS}
										ref={(node) => (button = node)}
										focusVisibleStyle={focusRingStyle(token("ring"))}
										class="w-full shrink-0 flex-row items-center"
										style={{ height: TICK_PITCH }}
										onFocus={() => {
											focused.set(index());
											focusTarget.set(null);
										}}
										onBlur={() => {
											if (focused() === index()) focused.set(null);
										}}
										onKeyDown={(event) => onKeyDown(event, index())}
										onPress={() => {
											if (focused() !== index()) focusTarget.set(index());
											props.onJump(index());
										}}
										tooltip={
											<Tooltip
												placement="right"
												delay={200}
												class="gap-1.5 rounded-lg border border-border bg-popover p-3"
												style={{
													width: 18 * DEFAULT_CHAT_REM,
													boxShadow: styleVar("pilo-shadow-floating"),
													zIndex: token("z-popover"),
												}}
											>
												<Text
													class="font-sans font-medium text-popover-foreground"
													style={{
														fontSize: chatPx(14),
														lineHeight: chatPx(17.5),
														numberOfLines: 3,
													}}
												>
													{() => tick().entry.title}
												</Text>
												{() => {
													const preview = tick().entry.preview;
													return preview ? (
														<Text
															class="font-sans text-muted-foreground"
															style={{
																fontSize: chatPx(12),
																lineHeight: chatPx(19.5),
																numberOfLines: 6,
															}}
														>
															{preview}
														</Text>
													) : null;
												}}
											</Tooltip>
										}
									>
										<View
											class={`pointer-events-none rounded-full duration-150 ease-out ${
												index() === hoveredIndex()
													? "bg-muted-foreground/80"
													: "bg-muted-foreground/45"
											}`}
											style={{
												height: TICK_HEIGHT,
												width: Math.min(trackWidth(), widthAt(tick())),
												transitionProperty: "background-color",
											}}
										/>
									</View>
								);
							}}
						</Each>
						{() =>
							showActiveTick() && (
								<View
									class="pointer-events-none absolute left-0 top-0 rounded-full bg-foreground/80 duration-150 ease-out"
									style={{
										height: TICK_HEIGHT,
										width: activeWidth(),
										transform: [
											{
												translateY:
													(props.activeIndex() - start()) * TICK_PITCH +
													(TICK_PITCH - TICK_HEIGHT) / 2,
											},
										],
										transitionProperty: "transform",
									}}
								/>
							)
						}
					</View>
				)
			}
		</View>
	);
}
