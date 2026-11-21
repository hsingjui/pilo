import { computed, effect, Text, untracked, View } from "nsh";

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

import { t } from "../app/i18n";
import { Icon } from "../ui/icon";
import { Spinner } from "../ui/spinner";
import {
	activitySummaryLabel,
	runningActivityLabel,
	workDurationText,
} from "./chat-activity-labels";
import { ChatDisclosureRow } from "./chat-disclosure-row";
import { type ChatExpansion, chatToolExpansionKey } from "./chat-expansion";
import type { ChatWorkPreferences } from "./chat-message-types";
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
			}) || expansion.findExpandedToolIndex(props.messageId(), activity()) >= 0,
		),
	);
	// The text that ends a group's run folds it, even after the user opened
	// it while it ran; a tool the user opened keeps it open.
	let previous: { key: string; eligible: boolean } | undefined;
	effect(() => {
		const key = groupKey();
		const eligible = props.followedByText() && collapse();
		const before = previous;
		previous = { key, eligible };
		if (before?.key !== key) return;
		if (!shouldAutoCollapseAssistantActivity(before.eligible, eligible)) return;
		untracked(() => {
			if (expansion.findExpandedToolIndex(props.messageId(), activity()) < 0) {
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
				{() => (
					<Icon name={open() ? "ChevronDown" : "ChevronRight"} size={14} />
				)}
				<View class="min-w-0 flex-1 flex-row items-center">
					{() =>
						hasDuration() ? (
							<View class="shrink-0 flex-row items-center">
								<Text class="font-sans text-base font-medium leading-snug text-foreground/75">
									{() => t("chat.workDuration", { duration: duration() })}
								</Text>
								<Text class="mx-1 font-sans text-base leading-snug text-muted-foreground/60">
									·
								</Text>
							</View>
						) : null
					}
					<Text class="min-w-0 flex-1 truncate font-sans text-base font-medium leading-snug text-muted-foreground">
						{label}
					</Text>
				</View>
				{() => (running() ? <Spinner size={14} /> : null)}
			</ChatDisclosureRow>
			{() =>
				open() ? (
					<View class="gap-0.5 pt-0.5">
						<Each of={activity()} key={(item) => item.id}>
							{(item) =>
								untracked(item).type === "thinking" ? (
									<ChatThinkingActivity
										activity={item as () => ThinkingActivity}
										expansion={expansion}
										expansionKey={() =>
											`${props.expansionKey()}:thinking:${item().id}`
										}
										showDuration={() => props.preferences().showWorkDuration}
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
		</View>
	);
}
