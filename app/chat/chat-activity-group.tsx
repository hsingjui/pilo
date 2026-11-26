import { computed, effect, Text, untracked, View } from "nsh";
import { Collapsible } from "nsh/base";

import {
	shouldAutoCollapseAssistantActivity,
	shouldInitiallyOpenAssistantActivity,
	summarizeAssistantActivity,
} from "@shared/chat/chat-activity-state";
import type {
	AssistantActivity,
	ThinkingActivity,
	ToolCallActivity,
} from "@shared/chat/chat-activity-types";

import { t } from "../shell/i18n";
import { Icon } from "../ui/icon";
import { chevronRotateStyle, collapsibleRevealProps } from "../ui/motion";
import { Spinner } from "../ui/spinner";
import {
	activitySummaryLabel,
	runningActivityLabel,
	workDurationText,
} from "./chat-activity-labels";
import { ChatDisclosureRow } from "./chat-disclosure-row";
import {
	type ChatExpansion,
	chatThinkingExpansionKey,
	chatToolExpansionKey,
} from "./chat-expansion";
import type { ChatWorkPreferences } from "./chat-message-types";
import {
	ChatReadingFont,
	createReadingIconAlignment,
	readingTextStyle,
} from "./chat-reading-font";
import { ChatThinkingActivity } from "./chat-thinking-activity";
import { ChatToolActivity } from "./chat-tool-activity";

export interface ChatActivityGroupProps {
	/** A run of thinking and tool calls between two texts of a reply. */
	activity: () => AssistantActivity[];
	messageId: () => string;
	/** The group's key in the chat: its reply and its first item. */
	expansionKey: () => string;
	/** A text follows the group: a finished group may then fold. */
	followedByText: () => boolean;
	/** The turn's work time, on the reply's first group only. */
	durationMs: () => number | undefined;
	expansion: ChatExpansion;
	preferences: () => ChatWorkPreferences;
}

/**
 * A run of thinking and tool calls under one header (the WebUI's
 * `AssistantActivityView`): while it runs, what it does now and a spinner;
 * once done, how long the turn worked and what the group did. A group a text
 * follows starts folded when finished work folds, and folds when that text
 * arrives, unless the user opened one of its tools.
 */
export function ChatActivityGroup(props: ChatActivityGroupProps) {
	const { activity, expansion } = props;
	const readingFont = ChatReadingFont();
	const iconAlignment = createReadingIconAlignment();
	const groupKey = computed(() => `${props.expansionKey()}:group`);
	const running = computed(() =>
		activity().some((item) => item.status === "running"),
	);
	const collapse = computed(
		() => props.preferences().collapseCompletedActivity,
	);
	const open = computed(() =>
		expansion.isOpen(
			groupKey(),
			shouldInitiallyOpenAssistantActivity({
				followedByText: props.followedByText(),
				collapseCompletedActivity: collapse(),
			}) ||
				expansion.hasUserExpandedActivity(
					props.messageId(),
					props.expansionKey(),
					activity(),
				),
		),
	);
	// 正文到达时若用户手动展开过思考过程、工具或该活动组，不强行折叠抽走正在阅读的内容。
	let previous: { key: string; eligible: boolean } | undefined;
	effect(() => {
		const key = groupKey();
		const eligible = props.followedByText() && collapse();
		const before = previous;
		previous = { key, eligible };
		if (before?.key !== key) return;
		if (!shouldAutoCollapseAssistantActivity(before.eligible, eligible)) return;
		untracked(() => {
			if (
				!expansion.hasUserExpandedActivity(
					props.messageId(),
					props.expansionKey(),
					activity(),
				)
			) {
				expansion.setOpen(key, false);
			}
		});
	});
	const duration = computed(() => {
		const durationMs = props.durationMs();
		return !running() &&
			props.preferences().showWorkDuration &&
			durationMs !== undefined
			? workDurationText(durationMs)
			: "";
	});
	const hasDuration = computed(() => duration() !== "");
	const label = computed(() =>
		running()
			? runningActivityLabel(activity())
			: activitySummaryLabel(summarizeAssistantActivity(activity())),
	);
	return (
		<View testID="chat-activity" class="mt-0.5 mb-1 w-full">
			<ChatDisclosureRow
				testID="chat-activity-toggle"
				class="min-h-7"
				expanded={open()}
				onPress={() => expansion.setOpen(groupKey(), !open())}
			>
				<View
					class="shrink-0 items-center justify-center"
					style={[iconAlignment.style(), chevronRotateStyle(open(), 0, 90)]}
				>
					<Icon name="ChevronRight" size={14} />
				</View>
				<View class="min-w-0 flex-1 flex-row items-center">
					{() =>
						hasDuration() ? (
							<View class="shrink-0 flex-row items-center">
								<Text
									class="font-sans font-medium leading-snug text-foreground/75"
									style={readingTextStyle(readingFont())}
								>
									{() => t("chat.workDuration", { duration: duration() })}
								</Text>
								<Text
									class="mx-1 font-sans leading-snug text-muted-foreground/60"
									style={readingTextStyle(readingFont())}
								>
									·
								</Text>
							</View>
						) : null
					}
					<Text
						class="min-w-0 flex-1 truncate font-sans font-medium leading-snug text-muted-foreground"
						style={readingTextStyle(readingFont())}
						onTextLayout={iconAlignment.onTextLayout}
					>
						{label}
					</Text>
				</View>
				{() =>
					running() ? (
						<View class="shrink-0" style={iconAlignment.style()}>
							<Spinner size={14} />
						</View>
					) : null
				}
			</ChatDisclosureRow>
			<Collapsible
				open={open()}
				{...collapsibleRevealProps()}
				content={
					<>
						{() =>
							open() ? (
								<View class="gap-0.5 pt-0.5">
									{/* Kept by place and kind, as the reply's segments are. */}
									<Each
										of={activity()}
										key={(item, index) =>
											`${index}:${item.type === "thinking" ? "thinking" : "tool"}`
										}
									>
										{(item) =>
											untracked(item).type === "thinking" ? (
												<ChatThinkingActivity
													activity={item as () => ThinkingActivity}
													expansion={expansion}
													expansionKey={() =>
														chatThinkingExpansionKey(
															props.expansionKey(),
															item().id,
														)
													}
													showDuration={() =>
														props.preferences().showWorkDuration
													}
												/>
											) : (
												<ChatToolActivity
													activity={item as () => ToolCallActivity}
													expansion={expansion}
													expansionKey={() =>
														chatToolExpansionKey(props.messageId(), item().id)
													}
												/>
											)
										}
									</Each>
								</View>
							) : null
						}
					</>
				}
			/>
		</View>
	);
}
