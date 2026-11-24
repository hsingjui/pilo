import { computed, platform, Text, View } from "nsh";

import { hasTokenUsage } from "@shared/api/token-usage";
import {
	getAssistantActivities,
	getAssistantMessageContent,
	getAssistantStreamingState,
	splitAssistantContentForDisplay,
} from "@shared/chat/chat-activity-state";

import { t } from "../shell/i18n";
import { createHover } from "../ui/hover";
import { Icon } from "../ui/icon";
import { Spinner } from "../ui/spinner";
import { workDurationText } from "./chat-activity-labels";
import { ChatAgentActivityIndicator } from "./chat-agent-activity";
import { ChatAssistantWork } from "./chat-assistant-work";
import { ChatCopyButton } from "./chat-copy-button";
import { ChatExpansion } from "./chat-expansion";
import { ChatMarkdown } from "./chat-markdown";
import { ChatMessageAction } from "./chat-message-action";
import { ChatReplyTime } from "./chat-reply-time";
import type {
	AssistantChatMessage,
	ChatMessageBody,
	ChatTextBody,
	ChatWorkPreferences,
} from "./chat-message-types";
import { ChatTurnUsage } from "./chat-turn-usage";
import { ConversationColumn } from "./conversation-column";
import { chatFooterHeight, chatMetadataText, chatPx } from "./layout";

const stalled = "PILO_STREAM_STALLED:";

/** The Host's defaults, while its preferences are not loaded. */
export const defaultChatWorkPreferences: ChatWorkPreferences = {
	collapseCompletedActivity: true,
	compactOutput: false,
	showWorkDuration: true,
};

const markdownText: ChatTextBody = (text, textKey) => (
	<ChatMarkdown text={text} textKey={textKey} />
);

function FooterSeparator() {
	return (
		<Text
			class="font-sans text-muted-foreground"
			style={chatMetadataText}
			accessible={false}
			accessibilityElementsHidden
		>
			·
		</Text>
	);
}

/** A reply: its texts and work, then what became of the turn. */
export function ChatAssistantMessage(props: {
	message: () => AssistantChatMessage;
	/** Draws the whole reply instead of its texts and work. */
	body?: ChatMessageBody<AssistantChatMessage>;
	/** Draws each text of the reply; Markdown without it. */
	text?: ChatTextBody;
	/** What the user opened and closed in this chat. */
	expansion?: ChatExpansion;
	preferences?: () => ChatWorkPreferences | undefined;
	/** Forks the session at this reply; absent where forking is off. */
	onFork?: (messageId: string) => void;
	/** Whether the current chat allows forking (e.g. false for temporary chats). */
	canFork?: () => boolean;
	/** This reply's fork is running. */
	forking?: () => boolean;
	/** Another fork, or a turn in flight, disables the button. */
	forkDisabled?: () => boolean;
}) {
	const { message } = props;
	const expansion = props.expansion ?? new ChatExpansion();
	const preferences = () => props.preferences?.() ?? defaultChatWorkPreferences;
	// The action row under a finished reply shows on hover or keyboard focus,
	// like the WebUI message footer.
	const hover = createHover();
	const error = computed(() => {
		const text = message().errorMessage;
		return text?.startsWith(stalled) ? t("chat.modelStreamStalled") : text;
	});
	const content = computed(() => getAssistantMessageContent(message()));
	const activity = computed(() => getAssistantActivities(content()));
	const keepWorkExpanded = computed(() => {
		const { streaming, completion, stopReason } = message();
		return (
			streaming === true ||
			completion === "continued" ||
			completion === "interrupted" ||
			stopReason === "aborted"
		);
	});
	const sections = computed(() =>
		splitAssistantContentForDisplay(
			content(),
			!keepWorkExpanded(),
			Boolean(message().errorMessage),
		),
	);
	const copyText = computed(() =>
		sections()
			.final.flatMap((item) => (item.type === "text" ? [item.text] : []))
			.join(""),
	);
	const hasCopyText = () => Boolean(copyText().trim());
	const turnUsage = computed(() => {
		const usage = message().usage;
		return hasTokenUsage(usage) ? usage : null;
	});
	// Only a cleanly finished reply can be a fork point, as in the WebUI.
	const canFork = computed(
		() =>
			props.onFork != null &&
			(props.canFork?.() ?? true) &&
			message().streaming !== true &&
			message().completion !== "continued" &&
			!message().errorMessage &&
			message().stopReason !== "aborted",
	);
	// What a running reply is doing, in words; nothing once it settles.
	// In compact output mode, the live compact header already shows the elapsed
	// timer and spinner while any activity exists, so avoid duplicating the
	// footer indicator.
	const streamingLabel = computed(() => {
		const { text, streaming, pendingStatus } = message();
		if (
			preferences().compactOutput &&
			streaming === true &&
			activity().length > 0
		) {
			return "";
		}
		const state = getAssistantStreamingState({
			text,
			activity: activity(),
			streaming,
			emptyState: pendingStatus ?? "waitingResponse",
		});
		return state ? t(`chat.${state}`) : "";
	});
	const stopped = computed(() => message().stopReason === "aborted");
	const time = () => message().time;
	// How long the turn worked, when no work header says it already.
	const duration = computed(() => {
		const durationMs = message().workDurationMs;
		return preferences().showWorkDuration &&
			activity().length === 0 &&
			durationMs !== undefined
			? workDurationText(durationMs)
			: "";
	});
	const showFooter = computed(() => {
		if (streamingLabel() || stopped() || message().streaming === true) {
			return false;
		}
		// A pre-compaction / split work segment with no reply text or usage does
		// not need a reserved footer row just for a timestamp.
		if (
			message().completion === "continued" &&
			!hasCopyText() &&
			!turnUsage()
		) {
			return false;
		}
		return Boolean(
			hasCopyText() || time() || duration() || turnUsage() || canFork(),
		);
	});
	return (
		<ConversationColumn
			class={platform.desktop && showFooter() ? "pt-3 pb-0" : "py-3"}
			{...hover.props}
		>
			{props.body ? (
				<View selectable>{props.body(message)}</View>
			) : (
				<ChatAssistantWork
					message={message}
					sections={sections}
					workActive={() => keepWorkExpanded() && activity().length > 0}
					expansion={expansion}
					preferences={preferences}
					text={props.text ?? markdownText}
				/>
			)}
			{() =>
				error() ? (
					<View
						role="alert"
						selectable
						class="mt-2 rounded-(--pilo-radius-lg) border border-destructive/20 bg-destructive/5 px-3 py-2"
					>
						<Text class="font-sans text-xs leading-5 text-destructive">
							{error}
						</Text>
					</View>
				) : null
			}
			{() =>
				streamingLabel() ? (
					<View class="mt-1 min-h-6 justify-center">
						<ChatAgentActivityIndicator
							testID="chat-reply-streaming"
							label={streamingLabel}
						/>
					</View>
				) : stopped() ? (
					<View class="mt-1 min-h-6 justify-center">
						<Text class="font-sans text-xs text-muted-foreground">
							{t("chat.stopped")}
						</Text>
					</View>
				) : showFooter() ? (
					<View
						testID="chat-reply-footer"
						class="flex-row flex-wrap items-center transition-opacity duration-150"
						style={{
							gap: chatPx(8),
							marginTop: platform.desktop ? 0 : chatPx(2),
							minHeight: chatFooterHeight(platform.desktop),
							opacity: !platform.desktop || hover.hovered() ? 1 : 0,
						}}
						focusWithinStyle={{ opacity: 1 }}
					>
						<View
							class="flex-row items-center"
							style={{ display: hasCopyText() || canFork() ? "flex" : "none" }}
						>
							{() =>
								hasCopyText() ? (
									<ChatCopyButton compact text={copyText} />
								) : null
							}
							{() =>
								canFork() ? (
									<ChatMessageAction
										compact
										testID={`fork:${message().id}`}
										disabled={
											(props.forkDisabled?.() ?? false) ||
											(props.forking?.() ?? false)
										}
										label={t(
											props.forking?.()
												? "chat.forking"
												: "chat.forkNewSession",
										)}
										onPress={() => props.onFork?.(message().id)}
									>
										{() =>
											props.forking?.() ? (
												<Spinner size={chatPx(14)} />
											) : (
												<Icon name="GitFork" size={chatPx(14)} />
											)
										}
									</ChatMessageAction>
								) : null
							}
						</View>
						{() =>
							time() ? (
								<ChatReplyTime time={time()} endedAtMs={message().endedAtMs} />
							) : null
						}
						{() => (time() && duration() ? <FooterSeparator /> : null)}
						{() =>
							duration() ? (
								<Text
									testID="chat-reply-duration"
									class="font-mono tabular-nums text-muted-foreground"
									style={chatMetadataText}
								>
									{duration}
								</Text>
							) : null
						}
						{() =>
							turnUsage() && (time() || duration()) ? <FooterSeparator /> : null
						}
						{() => {
							const usage = turnUsage();
							return usage ? <ChatTurnUsage usage={usage} /> : null;
						}}
					</View>
				) : null
			}
		</ConversationColumn>
	);
}
