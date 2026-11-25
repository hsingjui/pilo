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
	type AssistantStreamingState,
	getAssistantStreamingState,
	lastThinkingLine,
	pickCompactLiveActivity,
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
import { Tooltip } from "../ui/tooltip";
import {
	activitySummaryLabel,
	runningToolLabel,
	toolIconName,
	toolLabel,
	toolSkillName,
	workDurationText,
} from "./chat-activity-labels";
import { ChatActivityDot } from "./chat-agent-activity";
import { ChatDisclosureRow } from "./chat-disclosure-row";
import { type ChatExpansion, chatToolExpansionKey } from "./chat-expansion";
import type {
	AssistantChatMessage,
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

/** Activity details shared by the live group and the completed work. */
export function ChatCompactActivityItems(props: {
	activities: () => readonly AssistantActivity[];
	messageId: () => string;
	expansion: ChatExpansion;
	showDuration: () => boolean;
}) {
	return (
		<View class="gap-0.5">
			<Each
				of={props.activities()}
				key={(item, index) => `${index}:${item.type}`}
			>
				{(item) =>
					untracked(item).type === "thinking" ? (
						<ChatThinkingActivity
							activity={item as () => ThinkingActivity}
							expansion={props.expansion}
							expansionKey={() => `${props.messageId()}:thinking:${item().id}`}
							showDuration={props.showDuration}
						/>
					) : (
						<ChatToolActivity
							activity={item as () => ToolCallActivity}
							expansion={props.expansion}
							expansionKey={() =>
								chatToolExpansionKey(props.messageId(), item().id)
							}
						/>
					)
				}
			</Each>
		</View>
	);
}

/** One independently collapsible run of activity between assistant text blocks. */
export function ChatCompactActivityGroup(props: {
	activities: () => readonly AssistantActivity[];
	messageId: () => string;
	expansionKey: () => string;
	live: () => boolean;
	followedByText: () => boolean;
	expansion: ChatExpansion;
	preferences: () => ChatWorkPreferences;
}) {
	const { expansion } = props;
	const readingFont = ChatReadingFont();
	const groupKey = computed(() => `compact:${props.expansionKey()}`);
	const settled = computed(() => !props.live() || props.followedByText());
	const collapse = computed(
		() => props.preferences().collapseCompletedActivity,
	);
	const hasExpandedTool = computed(
		() =>
			expansion.findExpandedToolIndex(props.messageId(), props.activities()) >=
			0,
	);
	const open = computed(() =>
		expansion.isOpen(
			groupKey(),
			(!props.live() && !collapse()) || hasExpandedTool(),
		),
	);
	const toggleOpen = () => expansion.setOpen(groupKey(), !open());
	let previous: { key: string; eligible: boolean } | undefined;
	effect(() => {
		const key = groupKey();
		const eligible = settled() && collapse();
		const before = previous;
		previous = { key, eligible };
		if (before?.key !== key) return;
		if (!shouldAutoCollapseAssistantActivity(before.eligible, eligible)) return;
		untracked(() => {
			if (!hasExpandedTool()) expansion.setOpen(key, false);
		});
	});
	const preview = computed(() => pickCompactLivePreview(props.activities()));
	const liveActivity = computed(() => preview().liveActivity);
	const latestThought = computed(() => {
		const { latestThought, liveActivity } = preview();
		return (
			latestThought ?? (liveActivity?.type === "thinking" ? liveActivity : null)
		);
	});
	const thoughtLine = computed(() =>
		lastThinkingLine(latestThought()?.text ?? "", TICKER_PREVIEW_CHARS),
	);
	const hasThought = computed(() => Boolean(thoughtLine()));
	const liveFailed = computed(() => {
		const current = liveActivity();
		return current?.type === "tool" && current.isError === true;
	});
	const thoughtTooltip = computed(() => {
		const thought = latestThought();
		return thought ? trimTooltipText(thought.text) : null;
	});
	const liveTooltip = computed(() => {
		const current = liveActivity();
		return current?.type === "tool"
			? compactToolDisplay(current).tooltip
			: null;
	});

	// Animate live ticker swaps only after the first rendered step.
	let lastStepKey: string | null = null;
	const activeStepKey = computed(() => {
		const current = liveActivity();
		return current ? `${current.type}:${current.id}` : "";
	});
	const summaryLabel = computed(() =>
		activitySummaryLabel(summarizeAssistantActivity(props.activities())),
	);

	const header = () => {
		if (settled()) {
			return (
				<ChatDisclosureRow
					testID="chat-compact-activity-toggle"
					class={open() ? "bg-hover" : undefined}
					expanded={open()}
					onPress={toggleOpen}
				>
					{() => {
						const activity = liveActivity();
						const icon =
							hasThought() || activity?.type === "thinking"
								? "Sparkles"
								: activity && compactToolDisplay(activity).icon;
						return icon ? (
							<Icon
								name={icon}
								size={14}
								style={readingIconStyle(readingFont())}
							/>
						) : null;
					}}
					<Text
						class="w-0 min-w-0 flex-1 truncate font-sans leading-snug text-muted-foreground"
						style={readingTextStyle(readingFont())}
					>
						{summaryLabel}
					</Text>
				</ChatDisclosureRow>
			);
		}
		return (
			<View testID="chat-compact-live-preview" class="gap-0.5">
				{() =>
					hasThought() ? (
						<ChatDisclosureRow
							testID="chat-compact-thought-preview"
							class={open() ? "bg-hover" : undefined}
							expanded={open()}
							tooltip={
								<Tooltip class="max-w-80" delay={600} margin={16}>
									<Text class="line-clamp-24 font-sans">
										{() => thoughtTooltip() ?? ""}
									</Text>
								</Tooltip>
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
								{thoughtLine}
							</Text>
						</ChatDisclosureRow>
					) : null
				}
				{() => {
					if (open() && hasThought()) return null;
					const stepKey = activeStepKey();
					if (!stepKey) return null;
					const shouldAnimate = lastStepKey !== null && lastStepKey !== stepKey;
					lastStepKey = stepKey;
					return (
						<ChatDisclosureRow
							testID="chat-compact-activity-preview"
							tone={liveFailed() ? "destructive" : "muted"}
							class={open() && !hasThought() ? "bg-hover" : undefined}
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
	};

	return (
		<View class="w-full">
			{header}
			{() =>
				open() ? (
					<Scroll
						testID="chat-compact-activity-body"
						class="-mx-1 mt-0.5 max-h-80"
						bounces={false}
						scrollbar={{ vertical: scrollbarLook() }}
					>
						<View class="px-1 pr-3 pb-0.5">
							<ChatCompactActivityItems
								activities={props.activities}
								messageId={props.messageId}
								expansion={expansion}
								showDuration={() => props.preferences().showWorkDuration}
							/>
						</View>
					</Scroll>
				) : null
			}
		</View>
	);
}

function isPreOutputState(
	state: AssistantStreamingState | null,
): state is "starting" | "sending" | "waitingResponse" {
	return (
		state === "starting" || state === "sending" || state === "waitingResponse"
	);
}

/** The turn clock and live status are separate from all activity disclosures. */
export function ChatCompactWorkHeader(props: {
	message: () => AssistantChatMessage;
	activities: () => readonly AssistantActivity[];
	preferences: () => ChatWorkPreferences;
}) {
	const readingFont = ChatReadingFont();
	const live = computed(() => props.message().streaming === true);
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
		const firstThinkingStart = props
			.activities()
			.find(
				(item): item is ThinkingActivity =>
					item.type === "thinking" && item.startedAtMs !== undefined,
			)?.startedAtMs;
		if (firstThinkingStart !== undefined) return firstThinkingStart;
		if (fallbackStart?.id !== current.id) {
			fallbackStart = { id: current.id, startedAtMs: Date.now() };
		}
		return fallbackStart.startedAtMs;
	});
	const streamingState = computed(() => {
		if (!live()) return null;
		const current = props.message();
		return getAssistantStreamingState({
			text: current.text,
			activity: props.activities(),
			streaming: true,
			emptyState: current.pendingStatus ?? "waitingResponse",
		});
	});
	const title = computed(() => {
		const showDuration = props.preferences().showWorkDuration;
		if (live()) {
			const state = streamingState();
			const elapsedMs = Math.max(0, now() - startedAtMs());
			if (isPreOutputState(state)) {
				const label = t(`chat.${state}`);
				return showDuration && elapsedMs >= 1_000
					? `${label} · ${workDurationText(elapsedMs)}`
					: label;
			}
			if (showDuration) {
				return t("chat.workingDuration", {
					duration: workDurationText(elapsedMs),
				});
			}
			return props.activities().length === 0 && state
				? t(`chat.${state}`)
				: t("chat.workActivity");
		}
		if (!showDuration) return t("chat.workActivity");
		const durationMs = props.message().workDurationMs;
		return durationMs === undefined
			? t("chat.workActivity")
			: t("chat.workDuration", { duration: workDurationText(durationMs) });
	});
	const failed = computed(() => {
		const items = props.activities();
		if (!live())
			return items.some(
				(item) => item.type === "tool" && item.isError === true,
			);
		const current = pickCompactLiveActivity(items);
		return current?.type === "tool" && current.isError === true;
	});
	return (
		<View class="min-h-7 flex-row items-center justify-between gap-1.5 py-0.5">
			<View class="min-w-0 flex-1 flex-row items-center gap-1.5">
				{() =>
					live() ? <ChatActivityDot testID="chat-compact-live-dot" /> : null
				}
				<Text
					testID="chat-compact-header-title"
					class="min-w-0 shrink truncate font-sans font-medium tabular-nums leading-snug text-muted-foreground"
					style={readingTextStyle(readingFont())}
				>
					{title}
				</Text>
			</View>
			{() =>
				failed() ? (
					<Icon
						name="CircleAlert"
						size={14}
						color={token("destructive")}
						style={readingIconStyle(readingFont())}
					/>
				) : null
			}
		</View>
	);
}
