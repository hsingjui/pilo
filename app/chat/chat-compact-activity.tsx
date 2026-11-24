import {
	cleanup,
	computed,
	createMotion,
	type Easing,
	effect,
	reduceMotion,
	Scroll,
	signal,
	Text,
	token,
	untracked,
	View,
} from "nsh";

import {
	type AssistantContentItem,
	getAssistantActivities,
	lastThinkingLine,
	pickCompactLivePreview,
	shouldAutoCollapseAssistantActivity,
	summarizeAssistantActivity,
} from "@shared/chat/chat-activity-state";
import type {
	AssistantActivity,
	ThinkingActivity,
	ToolCallActivity,
} from "@shared/chat/chat-activity-types";
import {
	fileBasename,
	toolFilePath,
	toolPreview,
} from "@shared/chat/chat-tool-result";
import {
	countChatTodos,
	isChatTodoTool,
	parseChatTodos,
} from "@shared/chat/chat-todos";

import { t } from "../shell/i18n";
import { Icon } from "../ui/icon";
import { scrollbarLook } from "../ui/scrollbar";
import { Spinner } from "../ui/spinner";
import { Tooltip } from "../ui/tooltip";
import {
	activitySummaryLabel,
	runningToolLabel,
	toolIconName,
	toolLabel,
	toolSkillName,
	workDurationText,
} from "./chat-activity-labels";
import { ChatDisclosureRow } from "./chat-disclosure-row";
import { type ChatExpansion, chatToolExpansionKey } from "./chat-expansion";
import type {
	AssistantChatMessage,
	ChatTextBody,
	ChatWorkPreferences,
} from "./chat-message-types";
import {
	ChatReadingFont,
	readingIconStyle,
	readingTextStyle,
} from "./chat-reading-font";
import { ChatThinkingActivity } from "./chat-thinking-activity";
import { ChatToolActivity } from "./chat-tool-activity";

const tickerEaseOut: Easing = [0.22, 1, 0.36, 1];
const TICKER_PREVIEW_CHARS = 8_000;

function trimTooltipText(text: string): string | null {
	const trimmed = text
		.replace(/^\s*[\r\n]/, "")
		.replace(/(\S[^\S\r\n]*)[\r\n]\s*$/, "$1");
	if (!trimmed) return null;
	return trimmed.length > TICKER_PREVIEW_CHARS
		? `${trimmed.slice(0, TICKER_PREVIEW_CHARS)}\n…`
		: trimmed;
}

function compactToolDisplay(activity: ToolCallActivity) {
	const filePath = toolFilePath(activity);
	const skillName = toolSkillName(activity, filePath);
	const todos =
		!activity.isError && isChatTodoTool(activity.toolName)
			? parseChatTodos(activity.args, activity.result)
			: null;
	const label =
		activity.status === "running"
			? runningToolLabel(activity.toolName, skillName !== null)
			: skillName
				? t("chat.skill")
				: toolLabel(activity.toolName);
	const rawPreview = toolPreview(activity);
	const preview = todos
		? t("chat.todoProgress", {
				done: countChatTodos(todos).completed,
				total: todos.length,
			})
		: (skillName ?? (filePath ? fileBasename(filePath) : rawPreview));
	return {
		icon: toolIconName(activity.toolName, skillName !== null),
		label,
		preview,
		tooltip: filePath ?? rawPreview,
	};
}

function CompactTickerLine(props: {
	activity: () => AssistantActivity | null;
	animate: boolean;
}) {
	const readingFont = ChatReadingFont();
	const motion =
		props.animate && !reduceMotion()
			? createMotion({
					initial: { opacity: 0.25, translateY: 3 },
					enter: {
						keyframes: { opacity: [0.25, 1], translateY: [3, 0] },
						duration: 180,
						easing: tickerEaseOut,
					},
				})
			: null;
	if (motion) cleanup(() => motion.stop());

	return (
		<View
			class="min-w-0 flex-1 flex-row items-center gap-1.5"
			style={motion?.style}
		>
			{() => {
				const current = props.activity();
				if (!current) {
					return (
						<Text
							class="min-w-0 flex-1 truncate font-sans font-medium leading-snug text-muted-foreground"
							style={readingTextStyle(readingFont())}
						>
							{() => t("chat.processing")}
						</Text>
					);
				}
				if (current.type === "thinking") {
					const label = () =>
						current.status === "running"
							? t("chat.thinking")
							: t("chat.thought");
					const preview = () =>
						lastThinkingLine(current.text, TICKER_PREVIEW_CHARS);
					return (
						<View class="min-w-0 flex-1 flex-row items-center gap-1.5">
							<Icon
								name="Sparkles"
								size={14}
								style={readingIconStyle(readingFont())}
							/>
							<Text
								class="shrink-0 font-sans font-medium leading-snug text-muted-foreground"
								style={readingTextStyle(readingFont())}
							>
								{label}
							</Text>
							{() =>
								preview() ? (
									<Text
										class="w-0 min-w-0 flex-1 truncate font-sans leading-snug text-muted-foreground/75"
										style={readingTextStyle(readingFont())}
									>
										{preview}
									</Text>
								) : (
									<View class="min-w-0 flex-1" />
								)
							}
						</View>
					);
				}
				const failed = current.isError === true;
				const display = compactToolDisplay(current);
				return (
					<View class="min-w-0 flex-1 flex-row items-center gap-1.5">
						<Icon
							name={display.icon}
							size={14}
							style={readingIconStyle(readingFont())}
						/>
						<Text
							class={
								failed
									? "min-w-0 flex-1 truncate font-sans font-medium leading-snug text-destructive"
									: "min-w-0 flex-1 truncate font-sans font-medium leading-snug text-muted-foreground"
							}
							style={readingTextStyle(readingFont())}
						>
							{display.label}
							<Text
								class="font-mono font-normal text-muted-foreground"
								style={{ fontSize: token("pilo-code-font-size") }}
							>
								{display.preview ? `\u2002${display.preview}` : ""}
							</Text>
						</Text>
					</View>
				);
			}}
		</View>
	);
}

export interface ChatCompactWorkProps {
	message: () => AssistantChatMessage;
	workContent: () => readonly AssistantContentItem[];
	hasTrailingText: () => boolean;
	expansion: ChatExpansion;
	preferences: () => ChatWorkPreferences;
	text: ChatTextBody;
}

/**
 * Compact output renderer for an assistant turn's work:
 * - While streaming, shows a live elapsed timer header (`Working for ...`)
 *   with up to two flush preview rows underneath: the latest thinking summary
 *   on top and the live tool call or thinking row below.
 * - Clicking the header or either preview row toggles the same full process
 *   inside a max-height scrollable container.
 * - Once trailing answer text streams or the turn finishes, folds behind the
 *   header so the answer sits directly below.
 */
export function ChatCompactWork(props: ChatCompactWorkProps) {
	const { expansion } = props;
	const readingFont = ChatReadingFont();
	const messageId = () => props.message().id;
	const groupKey = computed(() => `compact-work:${messageId()}`);
	const live = computed(() => props.message().streaming === true);
	const visibleContent = computed(() =>
		props
			.workContent()
			.filter((item) => item.type !== "text" || item.text.trim().length > 0),
	);
	const activities = computed(() => getAssistantActivities(visibleContent()));
	const collapse = computed(
		() => props.preferences().collapseCompletedActivity,
	);
	const open = computed(() =>
		expansion.isOpen(
			groupKey(),
			(!live() && !collapse()) ||
				expansion.findExpandedToolIndex(messageId(), visibleContent()) >= 0,
		),
	);
	// If the user opened a live compact block, fold it once the turn settles or
	// trailing answer text arrives and completed-work folding is enabled.
	let previous: { key: string; eligible: boolean } | undefined;
	effect(() => {
		const key = groupKey();
		const eligible = (props.hasTrailingText() || !live()) && collapse();
		const before = previous;
		previous = { key, eligible };
		if (before?.key !== key) return;
		if (!shouldAutoCollapseAssistantActivity(before.eligible, eligible)) return;
		untracked(() => {
			if (expansion.findExpandedToolIndex(messageId(), visibleContent()) < 0) {
				expansion.setOpen(key, false);
			}
		});
	});

	// Live elapsed clock while streaming with work durations enabled.
	const now = signal(Date.now());
	effect(() => {
		if (!live() || !props.preferences().showWorkDuration) return;
		now.set(Date.now());
		const timer = setInterval(() => now.set(Date.now()), 1_000);
		return () => clearInterval(timer);
	});
	let fallbackStart: { id: string; startedAtMs: number } | undefined;
	const startedAtMs = computed(() => {
		const current = props.message();
		if (current.timestampMs !== undefined) return current.timestampMs;
		const firstThinkingStart = activities().find(
			(item): item is ThinkingActivity =>
				item.type === "thinking" && item.startedAtMs !== undefined,
		)?.startedAtMs;
		if (firstThinkingStart !== undefined) return firstThinkingStart;
		if (fallbackStart?.id !== current.id) {
			fallbackStart = { id: current.id, startedAtMs: Date.now() };
		}
		return fallbackStart.startedAtMs;
	});

	const preview = computed(() => pickCompactLivePreview(activities()));
	const liveActivity = computed(() => preview().liveActivity);
	const latestThought = computed(() => preview().latestThought);
	const showLivePreview = computed(
		() => live() && !open() && !props.hasTrailingText(),
	);
	const liveFailed = computed(() => {
		if (!live()) return false;
		const current = liveActivity();
		return current?.type === "tool" && current.isError === true;
	});
	const hasFailedTool = computed(() =>
		activities().some((item) => item.type === "tool" && item.isError === true),
	);
	const stepCount = computed(() => activities().length);
	const summaryLabel = computed(() =>
		activitySummaryLabel(summarizeAssistantActivity(activities())),
	);
	const headerTitle = computed(() => {
		const showDuration = props.preferences().showWorkDuration;
		if (live()) {
			if (!showDuration) return t("chat.workActivity");
			const elapsedMs = Math.max(0, now() - startedAtMs());
			return t("chat.workingDuration", {
				duration: workDurationText(elapsedMs),
			});
		}
		const durationMs = props.message().workDurationMs;
		return showDuration && durationMs !== undefined
			? t("chat.workDuration", { duration: workDurationText(durationMs) })
			: t("chat.workActivity");
	});
	const showHeaderSummary = computed(
		() =>
			activities().length > 0 &&
			((live() && props.hasTrailingText()) ||
				(!live() && !props.hasTrailingText())),
	);
	const thoughtTooltip = computed(() => {
		const thought = latestThought();
		return thought ? trimTooltipText(thought.text) : null;
	});
	const liveTooltip = computed(() => {
		const current = liveActivity();
		if (!current) return null;
		if (current.type === "thinking") return trimTooltipText(current.text);
		return compactToolDisplay(current).tooltip;
	});

	// Animate live ticker swaps only after the first rendered step.
	let lastStepKey: string | null = null;
	const activeStepKey = computed(() => {
		const current = liveActivity();
		return current ? `${current.type}:${current.id}` : "";
	});
	const hasLatestThought = computed(() => latestThought() !== null);
	const toggleOpen = () => expansion.setOpen(groupKey(), !open());

	return (
		<View testID="chat-compact-activity" class="mt-0.5 mb-1 w-full">
			<ChatDisclosureRow
				testID="chat-compact-activity-toggle"
				class="min-h-7"
				expanded={open()}
				onPress={toggleOpen}
			>
				{() => (
					<Icon
						name={open() ? "ChevronDown" : "ChevronRight"}
						size={14}
						style={readingIconStyle(readingFont())}
					/>
				)}
				<View class="min-w-0 flex-1 flex-row items-center">
					<Text
						testID="chat-compact-header-title"
						class="shrink-0 font-sans font-medium tabular-nums leading-snug text-muted-foreground"
						style={readingTextStyle(readingFont())}
					>
						{headerTitle}
					</Text>
					{() =>
						showHeaderSummary() ? (
							<View class="min-w-0 flex-1 flex-row items-center">
								<Text
									class="mx-1 shrink-0 font-sans leading-snug text-muted-foreground/60"
									style={readingTextStyle(readingFont())}
								>
									·
								</Text>
								<Text
									class="min-w-0 flex-1 truncate font-sans font-medium leading-snug text-muted-foreground"
									style={readingTextStyle(readingFont())}
								>
									{summaryLabel}
								</Text>
							</View>
						) : null
					}
				</View>
				{() =>
					live() ? (
						<View class="shrink-0 flex-row items-center gap-1.5">
							{() =>
								!props.hasTrailingText() && stepCount() > 1 ? (
									<Text
										testID="chat-compact-step-count"
										class="font-mono tabular-nums text-muted-foreground/70"
										style={{ fontSize: token("pilo-code-font-size") }}
									>
										{() => t("chat.compactSteps", { count: stepCount() })}
									</Text>
								) : null
							}
							{() =>
								liveFailed() ? (
									<Icon
										name="CircleAlert"
										size={14}
										color={token("destructive")}
										style={readingIconStyle(readingFont())}
									/>
								) : (
									<View
										class="shrink-0"
										style={readingIconStyle(readingFont())}
									>
										<Spinner size={14} />
									</View>
								)
							}
						</View>
					) : hasFailedTool() ? (
						<Icon
							name="CircleAlert"
							size={14}
							color={token("destructive")}
							style={readingIconStyle(readingFont())}
						/>
					) : null
				}
			</ChatDisclosureRow>
			{() => {
				if (!showLivePreview()) {
					lastStepKey = null;
					return null;
				}
				return (
					<View testID="chat-compact-live-preview" class="gap-0.5 pt-0.5">
						{() =>
							hasLatestThought() ? (
								<ChatDisclosureRow
									testID="chat-compact-thought-preview"
									expanded={open()}
									tooltip={
										thoughtTooltip() ? (
											<Tooltip class="max-w-80" delay={600} margin={16}>
												<Text class="line-clamp-24 font-sans">
													{() => thoughtTooltip() ?? ""}
												</Text>
											</Tooltip>
										) : undefined
									}
									onPress={toggleOpen}
								>
									<Icon
										name="Sparkles"
										size={14}
										style={readingIconStyle(readingFont())}
									/>
									<Text
										class="w-0 min-w-0 flex-1 truncate font-sans leading-snug text-muted-foreground"
										style={readingTextStyle(readingFont())}
									>
										{() => {
											const thought = latestThought();
											return thought
												? lastThinkingLine(thought.text, TICKER_PREVIEW_CHARS)
												: "";
										}}
									</Text>
								</ChatDisclosureRow>
							) : null
						}
						{() => {
							const stepKey = activeStepKey();
							if (!stepKey) return null;
							const shouldAnimate =
								lastStepKey !== null && lastStepKey !== stepKey;
							lastStepKey = stepKey;
							return (
								<ChatDisclosureRow
									testID="chat-compact-activity-preview"
									tone={liveFailed() ? "destructive" : "muted"}
									expanded={open()}
									tooltip={
										liveTooltip() ? (
											<Tooltip class="max-w-80" delay={600} margin={16}>
												<Text class="line-clamp-24 font-sans">
													{() => liveTooltip() ?? ""}
												</Text>
											</Tooltip>
										) : undefined
									}
									onPress={toggleOpen}
								>
									<CompactTickerLine
										activity={liveActivity}
										animate={shouldAnimate}
									/>
								</ChatDisclosureRow>
							);
						}}
					</View>
				);
			}}
			{() =>
				open() ? (
					<Scroll
						testID="chat-compact-activity-body"
						class="-mx-1 mt-0.5 max-h-80"
						bounces={false}
						scrollbar={{ vertical: scrollbarLook() }}
					>
						<View class="gap-0.5 px-1 pr-3 pb-0.5">
							<Each
								of={visibleContent()}
								key={(item, index) => `${index}:${item.type}`}
							>
								{(item) => {
									const current = untracked(item);
									if (current.type === "text") {
										return (
											<View selectable>
												{props.text(
													() => {
														const value = item();
														return value.type === "text" ? value.text : "";
													},
													() => `${messageId()}:${item().id}`,
												)}
											</View>
										);
									}
									if (current.type === "thinking") {
										return (
											<ChatThinkingActivity
												activity={item as () => ThinkingActivity}
												expansion={expansion}
												expansionKey={() =>
													`${messageId()}:thinking:${item().id}`
												}
												showDuration={() =>
													props.preferences().showWorkDuration
												}
											/>
										);
									}
									return (
										<ChatToolActivity
											activity={item as () => ToolCallActivity}
											expansion={expansion}
											expansionKey={() =>
												chatToolExpansionKey(messageId(), item().id)
											}
										/>
									);
								}}
							</Each>
						</View>
					</Scroll>
				) : null
			}
		</View>
	);
}
