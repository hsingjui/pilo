import { computed, platform, Text, View } from "nsh";

import { hasTokenUsage } from "@shared/api/token-usage";
import {
	getAssistantActivities,
	getAssistantMessageContent,
	getAssistantStreamingState,
	splitAssistantContentForDisplay,
} from "@shared/chat/chat-activity-state";

import { t } from "../app/i18n";
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
import type {
	AssistantChatMessage,
	ChatMessageBody,
	ChatTextBody,
	ChatWorkPreferences,
} from "./chat-message-types";
import { ChatTurnUsage } from "./chat-turn-usage";
import { ConversationColumn } from "./conversation-column";
import { chatMetadataText, chatPx } from "./layout";

const stalled = "PILO_STREAM_STALLED:";

/** The Host's defaults, while its preferences are not loaded. */
export const defaultChatWorkPreferences: ChatWorkPreferences = {
	collapseCompletedActivity: true,
	showWorkDuration: true,
};

const markdownText: ChatTextBody = (text) => <ChatMarkdown text={text} />;

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
	/** This reply's fork is running. */
	forking?: () => boolean;
	/** Another fork, or a turn in flight, disables the button. */
	forkDisabled?: () => boolean;
}) {
	const { message } = props;
	const expansion = props.expansion ?? new ChatExpansion();
	const preferences = () => props.preferences?.() ?? defaultChatWorkPreferences;
	// The action row under a finished reply shows on hover or keyboard focus,
	// like the Tauri message footer.
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
	// Only a cleanly finished reply can be a fork point, as in the Tauri app.
	const canFork = computed(
		() =>
			props.onFork != null &&
			message().streaming !== true &&
			message().completion !== "continued" &&
			!message().errorMessage &&
			message().stopReason !== "aborted",
	);
	// What a running reply is doing, in words; nothing once it settles.
	const streamingLabel = computed(() => {
		const { text, streaming, pendingStatus } = message();
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
	return (
		<ConversationColumn class="py-3" {...hover.props}>
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
				) : message().streaming !== true &&
				  (hasCopyText() ||
						time() ||
						duration() ||
						turnUsage() ||
						canFork()) ? (
					<View
						testID="chat-reply-footer"
						class="flex-row flex-wrap items-center transition-opacity duration-150"
						style={{
							gap: chatPx(8),
							marginTop: chatPx(2),
							minHeight: chatPx(28),
							opacity: !platform.desktop || hover.hovered() ? 1 : 0,
						}}
						focusWithinStyle={{ opacity: 1 }}
					>
						{() => (hasCopyText() ? <ChatCopyButton text={copyText} /> : null)}
						{() =>
							canFork() ? (
								<ChatMessageAction
									testID={`fork:${message().id}`}
									disabled={
										(props.forkDisabled?.() ?? false) ||
										(props.forking?.() ?? false)
									}
									label={t(
										props.forking?.() ? "chat.forking" : "chat.forkNewSession",
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
						{() =>
							time() ? (
								<Text
									class="font-sans tabular-nums text-muted-foreground"
									style={chatMetadataText}
								>
									{time}
								</Text>
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
