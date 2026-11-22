import { computed, Text, untracked, View } from "nsh";

import type {
	AssistantContentDisplaySections,
	AssistantContentItem,
} from "@shared/chat/chat-activity-state";
import type { AssistantActivity } from "@shared/chat/chat-activity-types";

import { t } from "../app/i18n";
import { Icon } from "../ui/icon";
import { workDurationText } from "./chat-activity-labels";
import { ChatActivityGroup } from "./chat-activity-group";
import { ChatDisclosureRow } from "./chat-disclosure-row";
import type { ChatExpansion } from "./chat-expansion";
import type {
	AssistantChatMessage,
	ChatTextBody,
	ChatWorkPreferences,
} from "./chat-message-types";
import { ChatReadingFont, readingTextStyle } from "./chat-reading-font";

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
	const segments: WorkSegment[] = [];
	let first = true;
	for (let index = 0; index < content.length; index += 1) {
		const item = content[index];
		if (item.type === "text") {
			if (item.text)
				segments.push({ type: "text", id: item.id, text: item.text });
			continue;
		}
		const items: AssistantActivity[] = [];
		const start = index;
		while (index < content.length && content[index].type !== "text") {
			items.push(content[index] as AssistantActivity);
			index += 1;
		}
		index -= 1;
		const next = content[index + 1];
		segments.push({
			type: "activity",
			id: items[0]?.id ?? `activity-${start}`,
			items,
			followedByText:
				(next?.type === "text" && next.text.length > 0) ||
				(index === content.length - 1 && followedByTextAfterContent),
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
		<View class="w-full">
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
					<Icon name={open() ? "ChevronDown" : "ChevronRight"} size={14} />
				)}
				<Text
					class="min-w-0 flex-1 truncate font-sans font-medium leading-snug text-muted-foreground"
					style={readingTextStyle(readingFont())}
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

/**
 * A reply's texts and work, laid out as the WebUI's `AssistantMessage`
 * does: while the turn runs (or when it was interrupted) everything stays
 * in order under an open work header; once it ends, the work before the
 * final text folds behind one header and the final text stays below it.
 */
export function ChatAssistantWork(
	props: WorkContext & {
		sections: () => AssistantContentDisplaySections;
		workActive: () => boolean;
	},
) {
	const { message, sections } = props;
	const finalContent = () => sections().final;
	const layout = computed(() =>
		props.workActive()
			? "active"
			: sections().hasCollapsedWork
				? "folded"
				: "plain",
	);
	return () => {
		switch (layout()) {
			case "active":
				return <WorkedRegion {...props} content={finalContent} active />;
			case "folded":
				return (
					<View class="w-full">
						<WorkedRegion
							{...props}
							content={() => sections().work}
							active={false}
							followedByTextAfterContent={() =>
								finalContent().some(
									(item) => item.type === "text" && item.text.length > 0,
								)
							}
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
