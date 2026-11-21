import { computed, signal, Text, View } from "nsh";

import type { ThinkingActivity } from "@shared/chat/chat-activity-types";

import { t } from "../app/i18n";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Tooltip } from "../ui/tooltip";
import { workDurationText } from "./chat-activity-labels";
import { ChatDisclosureRow } from "./chat-disclosure-row";
import { ChatDisclosureAction, type ChatExpansion } from "./chat-expansion";
import { ChatMarkdown } from "./chat-markdown";
import { ChatReadingFont, readingTextStyle } from "./chat-reading-font";

// How much thinking renders at first, and how much more each press shows.
const THINKING_REVEAL_CHARS = 8_000;

/** The last line of thinking that has text, scanned from the end. */
function lastThinkingLine(text: string): string {
	let end = text.length;
	while (end > 0) {
		const start = text.lastIndexOf("\n", end - 1) + 1;
		const line = text.slice(start, end).trim();
		if (line) return line.slice(0, THINKING_REVEAL_CHARS);
		end = start - 1;
	}
	return "";
}

/**
 * One block of thinking: a row with its last line, opening to the whole
 * text. It starts closed, as a tool does, and keeps the user's choice by
 * key, so a block that finishes does not close what the user opened.
 */
export function ChatThinkingActivity(props: {
	activity: () => ThinkingActivity;
	expansion: ChatExpansion;
	expansionKey: () => string;
	showDuration: () => boolean;
}) {
	const { activity } = props;
	const disclose = ChatDisclosureAction();
	const readingFont = ChatReadingFont();
	const running = computed(() => activity().status === "running");
	const open = computed(() =>
		props.expansion.isOpen(props.expansionKey(), false),
	);
	const preview = computed(() => lastThinkingLine(activity().text));
	const hasDetails = computed(() => preview().length > 0);
	const showDetails = computed(() => hasDetails() && open());
	const showPreview = computed(() => hasDetails() && !open());
	const revealed = signal(THINKING_REVEAL_CHARS);
	// Bound the Markdown work even for runaway output, and never cut a
	// surrogate pair in two.
	const visibleEnd = computed(() => {
		const { text } = activity();
		let end = Math.min(text.length, revealed());
		if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) {
			end += 1;
		}
		return end;
	});
	const hasHiddenText = computed(() => visibleEnd() < activity().text.length);
	const label = computed(() => {
		if (running()) return t("chat.thinking");
		const { startedAtMs, endedAtMs } = activity();
		const durationMs =
			startedAtMs !== undefined && endedAtMs !== undefined
				? Math.max(0, endedAtMs - startedAtMs)
				: undefined;
		// Under a second, or without both times, it only says it thought.
		return props.showDuration() &&
			durationMs !== undefined &&
			durationMs >= 1000
			? t("chat.thoughtDuration", { duration: workDurationText(durationMs) })
			: t("chat.thought");
	});
	return (
		<View class="w-full">
			<ChatDisclosureRow
				testID="chat-thinking"
				expanded={hasDetails() ? open() : undefined}
				disabled={!hasDetails()}
				class={open() ? "bg-hover" : undefined}
				tooltip={
					showPreview() ? (
						<Tooltip class="max-w-80" delay={300} margin={16}>
							<Text class="line-clamp-24 font-sans">
								{() => {
									const { text } = activity();
									return text.length > THINKING_REVEAL_CHARS
										? `${text.slice(0, THINKING_REVEAL_CHARS)}\n…`
										: text;
								}}
							</Text>
						</Tooltip>
					) : undefined
				}
				onPress={() => props.expansion.setOpen(props.expansionKey(), !open())}
			>
				<Icon name="Sparkles" size={14} />
				<Text
					class="shrink-0 font-sans font-medium leading-snug text-muted-foreground"
					style={readingTextStyle(readingFont())}
				>
					{label}
				</Text>
				{() =>
					showPreview() ? (
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
			</ChatDisclosureRow>
			{() =>
				showDetails() ? (
					<View class="items-start pt-0.5">
						<ChatMarkdown
							class="text-muted-foreground"
							compact
							text={() => activity().text.slice(0, visibleEnd())}
						/>
						{() =>
							hasHiddenText() ? (
								<Button
									variant="ghost"
									size="sm"
									onPress={() =>
										disclose(() =>
											revealed.update((value) => value + THINKING_REVEAL_CHARS),
										)
									}
								>
									<Text class="font-sans">
										{() => t("chat.showMoreThinking")}
									</Text>
								</Button>
							) : null
						}
					</View>
				) : null
			}
		</View>
	);
}
