import { computed, Text, token, View } from "nsh";
import { Button as BaseButton } from "nsh/base";

import {
	fileMentionName,
	readChatMentionParts,
	type ChatMention,
} from "@shared/chat/chat-mentions";
import { parseSkillInvocation } from "@shared/chat/skill-invocation";
import { t } from "../shell/i18n";
import { blurOnPointerPress, focusRingStyle } from "../ui/focus-ring-style";
import { Icon, type IconName } from "../ui/icon";
import { Tooltip } from "../ui/tooltip";
import { ChatMediaActions } from "./chat-media-actions";
import { ChatMentionInline } from "./chat-mention-inline";
import { ChatReadingFont, readingTextStyle } from "./chat-reading-font";
import type { UserChatMessage } from "./chat-message-types";
import { chatPx } from "./layout";

const BADGE_CLASS =
	"max-w-full min-w-0 flex-row items-center rounded-md border border-foreground/10 bg-background/40 focus-visible:outline-hidden";

/**
 * 用户消息气泡正文：
 * - Skill 调用保留紧凑徽标展示，不回显 Pi 展开的 Skill 正文；
 * - `@文件` 与 `@会话` 按原始位置以内联方式展示（图标 + 名称 + 悬停完整路径 + 可点击态）。
 */
export function ChatUserMessageBody(props: { message: () => UserChatMessage }) {
	const skill = computed(() => parseSkillInvocation(props.message().text));
	const text = computed(() => {
		const invocation = skill();
		return invocation
			? invocation.additionalInstructions
			: props.message().text;
	});
	return () => {
		const invocation = skill();
		return (
			<View class="min-w-0 max-w-full gap-1.5">
				{invocation ? (
					<Badge
						icon="Sparkles"
						label={invocation.name}
						mono
						tooltip={invocation.location ?? undefined}
					/>
				) : null}
				<MentionText text={text} />
			</View>
		);
	};
}

function MentionText(props: { text: () => string }) {
	const media = ChatMediaActions();
	const readingFont = ChatReadingFont();
	const parsed = computed(() => {
		const raw = props.text();
		if (!raw) return null;
		// 无 `@` 时不订阅全量 sessionMentions，直接走单 Text 节点渲染。
		if (!raw.includes("@")) return { plain: raw as string, lines: null };
		const sessions = media.sessionMentions?.() ?? new Map();
		const lines = raw
			.split("\n")
			.map((line) => readChatMentionParts(line, sessions));
		if (!lines.some((parts) => parts.some((part) => Boolean(part.mention)))) {
			return { plain: raw as string, lines: null };
		}
		return { plain: null, lines };
	});
	return () => {
		const content = parsed();
		if (!content) return null;
		const font = readingFont();
		const textStyle = readingTextStyle(font);
		if (content.plain !== null) {
			return (
				<Text class="font-sans leading-[1.6] text-foreground" style={textStyle}>
					{content.plain}
				</Text>
			);
		}
		return (
			<View class="min-w-0 max-w-full">
				{content.lines.map((parts) => {
					const hasMention = parts.some((part) => Boolean(part.mention));
					if (!hasMention) {
						const lineText = parts.map((part) => part.value).join("");
						return (
							<Text
								class="font-sans leading-[1.6] text-foreground"
								style={textStyle}
							>
								{lineText || " "}
							</Text>
						);
					}
					return (
						<Text
							class="font-sans leading-[1.6] text-foreground"
							style={textStyle}
						>
							{parts.map((part) => {
								if (!part.mention) return part.value;
								return (
									<InlineMessageMention
										mention={part.mention}
										fontSize={font.fontSize}
										fontFamily={font.fontFamily}
									/>
								);
							})}
						</Text>
					);
				})}
			</View>
		);
	};
}

function InlineMessageMention(props: {
	mention: ChatMention;
	fontSize: number;
	fontFamily: string;
}) {
	const media = ChatMediaActions();
	const { mention } = props;
	if (mention.kind === "session") {
		return (
			<ChatMentionInline
				testID="chat-user-mention:session"
				kind="session"
				label={mention.session.title}
				path={mention.path}
				detail={mention.session.projectName}
				fontSize={props.fontSize}
				fontFamily={props.fontFamily}
				interactive={false}
			/>
		);
	}
	const { path } = mention;
	const openable = () =>
		Boolean(media.openFile && (media.canOpenFile?.(path) ?? true));
	return (
		<ChatMentionInline
			testID="chat-user-mention:file"
			kind="file"
			label={fileMentionName(path)}
			path={path}
			fontSize={props.fontSize}
			fontFamily={props.fontFamily}
			interactive={openable()}
			accessibilityLabel={openable() ? t("chat.openFile", { path }) : undefined}
			onPress={() => {
				if (openable()) media.openFile?.(path);
			}}
		/>
	);
}

function Badge(props: {
	icon: IconName;
	label: string;
	tooltip?: string;
	mono?: boolean;
	accessibilityLabel?: string;
	onPress?: () => void;
}) {
	const tooltip = props.tooltip ? (
		<Tooltip class="max-w-96" delay={300} margin={16}>
			<Text class="font-mono text-xs">{props.tooltip}</Text>
		</Tooltip>
	) : undefined;
	const body = (
		<>
			<Icon
				name={props.icon}
				size={chatPx(14)}
				color={token("muted-foreground")}
			/>
			<Text
				class={`min-w-0 shrink truncate text-foreground ${props.mono ? "font-mono" : "font-sans"}`}
				style={{ fontSize: chatPx(12) }}
			>
				{props.label}
			</Text>
		</>
	);
	const badgeStyle = {
		gap: chatPx(6),
		paddingHorizontal: chatPx(8),
		paddingVertical: chatPx(4),
	};
	if (!props.onPress) {
		return (
			<View
				class={BADGE_CLASS}
				style={badgeStyle}
				accessible
				accessibilityLabel={props.accessibilityLabel ?? props.label}
				tooltip={tooltip}
			>
				{body}
			</View>
		);
	}
	const pointerBlur = blurOnPointerPress();
	return (
		<BaseButton
			ref={pointerBlur.ref}
			onMouseUp={pointerBlur.onMouseUp}
			class={`${BADGE_CLASS} hover:bg-muted`}
			style={badgeStyle}
			focusVisibleStyle={focusRingStyle(token("ring"))}
			accessibilityLabel={props.accessibilityLabel ?? props.label}
			tooltip={tooltip}
			onPress={props.onPress}
		>
			{body}
		</BaseButton>
	);
}
