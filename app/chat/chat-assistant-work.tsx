import { computed, Scroll, Text, untracked, View } from "nsh";

import type {
	AssistantContentDisplaySections,
	AssistantContentItem,
} from "@shared/chat/chat-activity-state";
import type { AssistantActivity } from "@shared/chat/chat-activity-types";

import { t } from "../shell/i18n";
import { Icon } from "../ui/icon";
import { scrollbarLook } from "../ui/scrollbar";
import { workDurationText } from "./chat-activity-labels";
import { ChatActivityGroup } from "./chat-activity-group";
import {
	ChatCompactActivityGroup,
	ChatCompactActivityItems,
	ChatCompactWorkHeader,
} from "./chat-compact-activity";
import { ChatDisclosureRow } from "./chat-disclosure-row";
import type { ChatExpansion } from "./chat-expansion";
import type {
	AssistantChatMessage,
	ChatTextBody,
	ChatWorkPreferences,
} from "./chat-message-types";
import {
	ChatReadingFont,
	createReadingIconAlignment,
	readingTextStyle,
} from "./chat-reading-font";

/** A reply's content as it shows: each text, and each run of work between. */
type WorkSegment =
	| { type: "text"; id: string; text: string }
	| {
			type: "activity";
			id: string;
			items: AssistantActivity[];
			followedByText: boolean;
			first: boolean;
	  };

function workSegments(
	content: readonly AssistantContentItem[],
	followedByTextAfterContent: boolean,
): WorkSegment[] {
	const visible = content.filter(
		(item) => item.type !== "text" || item.text.trim().length > 0,
	);
	const segments: WorkSegment[] = [];
	let first = true;
	for (let index = 0; index < visible.length; index += 1) {
		const item = visible[index];
		if (item.type === "text") {
			segments.push({ type: "text", id: item.id, text: item.text });
			continue;
		}
		const items: AssistantActivity[] = [];
		const start = index;
		while (index < visible.length && visible[index].type !== "text") {
			items.push(visible[index] as AssistantActivity);
			index += 1;
		}
		index -= 1;
		const next = visible[index + 1];
		segments.push({
			type: "activity",
			id: items[0]?.id ?? `activity-${start}`,
			items,
			followedByText:
				next?.type === "text" ||
				(index === visible.length - 1 && followedByTextAfterContent),
			first,
		});
		first = false;
	}
	return segments;
}

interface WorkContext {
	message: () => AssistantChatMessage;
	expansion: ChatExpansion;
	preferences: () => ChatWorkPreferences;
	text: ChatTextBody;
}

/** Texts and work groups in order (the WebUI's `renderAssistantContentNodes`). */
function WorkSegments(
	props: WorkContext & {
		content: () => readonly AssistantContentItem[];
		/** The turn's work time, shown on the first group. */
		durationMs?: () => number | undefined;
		followedByTextAfterContent?: () => boolean;
		compact?: "grouped" | "expanded";
	},
) {
	const segments = computed(() =>
		workSegments(
			props.content(),
			props.followedByTextAfterContent?.() ?? false,
		),
	);
	const messageId = () => props.message().id;
	return (
		<View class={props.compact ? "w-full gap-1.5" : "w-full"}>
			{/* Kept by place and kind, not id: a list cell reused for another
				reply keeps its texts and groups and shows the new content in them,
				rather than making them all again. */}
			<Each
				of={segments()}
				key={(segment, index) => `${index}:${segment.type}`}
			>
				{(segment) => {
					// A segment keeps its type for its key; only its content changes.
					const current = untracked(segment);
					if (current.type === "text") {
						return (
							<View selectable>
								{props.text(
									() => {
										const value = segment();
										return value.type === "text" ? value.text : "";
									},
									() => `${messageId()}:${segment().id}`,
								)}
							</View>
						);
					}
					const activity = () => {
						const value = segment();
						return value.type === "activity" ? value : current;
					};
					if (props.compact === "expanded") {
						return (
							<ChatCompactActivityItems
								activities={() => activity().items}
								messageId={messageId}
								expansion={props.expansion}
								showDuration={() => props.preferences().showWorkDuration}
							/>
						);
					}
					if (props.compact === "grouped") {
						return (
							<ChatCompactActivityGroup
								activities={() => activity().items}
								messageId={messageId}
								expansionKey={() => `${messageId()}:${activity().id}`}
								live={() => props.message().streaming === true}
								followedByText={() => activity().followedByText}
								expansion={props.expansion}
								preferences={props.preferences}
							/>
						);
					}
					return (
						<ChatActivityGroup
							activity={() => activity().items}
							messageId={messageId}
							expansionKey={() => `${messageId()}:${activity().id}`}
							followedByText={() => activity().followedByText}
							durationMs={() =>
								activity().first ? props.durationMs?.() : undefined
							}
							expansion={props.expansion}
							preferences={props.preferences}
						/>
					);
				}}
			</Each>
		</View>
	);
}

/**
 * All of a reply's work behind one header (the WebUI's
 * `AssistantWorkedRegion`): the whole turn while it runs, the work before
 * the final text once it ends. Running, it starts open; finished, it starts
 * folded when finished work folds.
 */
function WorkedRegion(
	props: WorkContext & {
		content: () => readonly AssistantContentItem[];
		active: boolean;
		followedByTextAfterContent?: () => boolean;
	},
) {
	const { expansion } = props;
	const readingFont = ChatReadingFont();
	const iconAlignment = createReadingIconAlignment();
	const key = computed(
		() =>
			`worked:${props.message().id}:${props.active ? "active" : "complete"}`,
	);
	const open = computed(() =>
		expansion.isOpen(
			key(),
			props.active ||
				!props.preferences().collapseCompletedActivity ||
				expansion.findExpandedToolIndex(props.message().id, props.content()) >=
					0,
		),
	);
	const label = computed(() => {
		const durationMs = props.message().workDurationMs;
		return props.preferences().showWorkDuration && durationMs !== undefined
			? t("chat.workDuration", { duration: workDurationText(durationMs) })
			: t("chat.workActivity");
	});
	return (
		<View testID="chat-work" class="mt-0.5 mb-1 w-full">
			<ChatDisclosureRow
				testID="chat-work-toggle"
				expanded={open()}
				onPress={() => expansion.setOpen(key(), !open())}
			>
				{() => (
					<Icon
						name={open() ? "ChevronDown" : "ChevronRight"}
						size={14}
						style={iconAlignment.style()}
					/>
				)}
				<Text
					class="min-w-0 flex-1 truncate font-sans font-medium leading-snug text-muted-foreground"
					style={readingTextStyle(readingFont())}
					onTextLayout={iconAlignment.onTextLayout}
				>
					{label}
				</Text>
			</ChatDisclosureRow>
			{() =>
				open() ? (
					<View class="pt-0.5">
						<WorkSegments
							{...props}
							content={props.content}
							followedByTextAfterContent={props.followedByTextAfterContent}
						/>
					</View>
				) : null
			}
		</View>
	);
}

/** Compact turns fold groups while live and all pre-answer work once done. */
export function ChatAssistantWork(
	props: WorkContext & {
		sections: () => AssistantContentDisplaySections;
		activities: () => readonly AssistantActivity[];
		workActive: () => boolean;
	},
) {
	const { message, sections, activities, expansion } = props;
	const finalContent = () => sections().final;
	const hasVisibleFinalText = computed(() =>
		finalContent().some(
			(item) => item.type === "text" && item.text.trim().length > 0,
		),
	);
	const showLiveHeader = computed(
		() => props.preferences().showWorkDuration || activities().length > 0,
	);
	const hasLiveBody = computed(
		() => activities().length > 0 || hasVisibleFinalText(),
	);
	const completedKey = () => `compact-complete:${message().id}`;
	const completedOpen = computed(() =>
		expansion.isOpen(
			completedKey(),
			!props.preferences().collapseCompletedActivity,
		),
	);
	const layout = computed(() => {
		if (props.preferences().compactOutput) {
			if (message().streaming === true) return "compact";
			if (sections().hasCollapsedWork) return "compactComplete";
		}
		return props.workActive()
			? "active"
			: sections().hasCollapsedWork
				? "folded"
				: "plain";
	});
	return () => {
		switch (layout()) {
			case "compact":
				return (
					<View
						testID="chat-compact-activity"
						class={
							showLiveHeader() || hasLiveBody()
								? hasLiveBody()
									? "mt-0.5 mb-1 w-full"
									: "mt-0.5 mb-0.5 w-full"
								: "w-full"
						}
					>
						{() =>
							showLiveHeader() ? (
								<View>
									<ChatCompactWorkHeader
										message={message}
										activities={activities}
										preferences={props.preferences}
									/>
									<View
										testID="chat-compact-header-divider"
										class="mt-0.5 h-px bg-border/60"
										accessible={false}
										accessibilityElementsHidden
									/>
								</View>
							) : null
						}
						{() =>
							hasLiveBody() ? (
								<View class={showLiveHeader() ? "pt-1.5" : undefined}>
									<WorkSegments
										{...props}
										content={finalContent}
										compact="grouped"
									/>
								</View>
							) : null
						}
					</View>
				);
			case "compactComplete": {
				const iconAlignment = createReadingIconAlignment();
				return (
					<View class="w-full">
						<View testID="chat-compact-activity" class="mt-0.5 mb-1 w-full">
							<ChatDisclosureRow
								testID="chat-compact-activity-toggle"
								class="min-h-7 py-0"
								expanded={completedOpen()}
								onPress={() =>
									expansion.setOpen(completedKey(), !completedOpen())
								}
							>
								{() => (
									<Icon
										name={completedOpen() ? "ChevronDown" : "ChevronRight"}
										size={14}
										style={iconAlignment.style()}
									/>
								)}
								<View class="min-w-0 flex-1">
									<ChatCompactWorkHeader
										message={message}
										activities={activities}
										preferences={props.preferences}
										iconAlignment={iconAlignment}
									/>
								</View>
							</ChatDisclosureRow>
							{() =>
								completedOpen() ? (
									<Scroll
										testID="chat-compact-activity-body"
										class="-mx-1 mt-0.5 max-h-80"
										bounces={false}
										scrollbar={{ vertical: scrollbarLook() }}
									>
										<View class="px-1 pr-3 pb-0.5">
											<WorkSegments
												{...props}
												content={() => sections().work}
												compact="expanded"
											/>
										</View>
									</Scroll>
								) : null
							}
						</View>
						<WorkSegments {...props} content={finalContent} />
					</View>
				);
			}
			case "active":
				return <WorkedRegion {...props} content={finalContent} active />;
			case "folded":
				return (
					<View class="w-full">
						<WorkedRegion
							{...props}
							content={() => sections().work}
							active={false}
							followedByTextAfterContent={hasVisibleFinalText}
						/>
						<WorkSegments {...props} content={finalContent} />
					</View>
				);
			case "plain":
				return (
					<WorkSegments
						{...props}
						content={finalContent}
						durationMs={() => message().workDurationMs}
					/>
				);
		}
	};
}
