import {
	type JSX,
	platform,
	Scroll,
	type ScrollRef,
	Text,
	View,
	type ViewRef,
	cleanup,
	createMotion,
	effect,
	reduceMotion,
	token,
	windowSize,
} from "nsh";
import { Button as BaseButton } from "nsh/base";
import { fileMentionPath } from "@shared/chat/chat-mentions";
import {
	TRIGGER_META,
	type ComposerSuggestion,
	type MentionTab,
} from "@shared/chat/composer-suggestions";
import { t } from "../shell/i18n";
import { ChatReadingFont } from "../chat/chat-reading-font";
import { chatMetadataText, chatPx } from "../chat/layout";
import { FileTypeIcon } from "../ui/file-type-icon";
import { blurOnPointerPress, focusRingStyle } from "../ui/focus-ring-style";
import { createHover } from "../ui/hover";
import { Icon, type IconName } from "../ui/icon";
import { menuListSpacing, menuPopupClass, menuPopupStyle } from "../ui/menu";
import { menuRowClass } from "../ui/menu-row";
import { MOTION, tactileTransition } from "../ui/motion";
import { Tooltip } from "../ui/tooltip";

export function inputLineHeight(fontSize: number) {
	return Math.max(chatPx(20), Math.round(fontSize * 1.35));
}

const SUGGESTION_ICONS: Record<ComposerSuggestion["kind"], IconName> = {
	file: "FileCode2",
	session: "MessageSquare",
	command: "TerminalSquare",
};

/**
 * The `@`/`/` menu over the composer, as React's `ComposerSuggestionMenu`:
 * the menu surface and rows, an icon, the name and its detail on one line;
 * `@` adds its file and session tabs over a list that scrolls.
 */
export function SuggestionMenu(props: {
	trigger: () => "@" | "/";
	query: () => string;
	width: () => number;
	tab: () => MentionTab;
	categoryFocused: () => boolean;
	onTab: (tab: MentionTab) => void;
	items: () => readonly ComposerSuggestion[];
	/** The highlighted row; -1 while the `@` tabs have the keys. */
	index: () => number;
	onHighlight: (index: number) => void;
	onPick: (suggestion: ComposerSuggestion) => void;
}) {
	const title = () =>
		props.trigger() === "@" && props.tab() === "session"
			? t("chat.sessionSuggestion")
			: t(TRIGGER_META[props.trigger()].titleKey);
	let list: ScrollRef | undefined;
	const rows: (ViewRef | undefined)[] = [];
	// The highlighted row stays in view, as React scrolls its list.
	effect(() => {
		const i = props.index();
		props.items();
		if (i < 0) list?.scrollTo({ y: 0, animated: false });
		else rows[i]?.reveal({ vertical: "nearest", animated: false });
	});
	const enterMotion = createMotion({
		enter: reduceMotion()
			? {
					keyframes: { opacity: [0, 1] },
					duration: 80,
					easing: MOTION.easing.standardTuple,
				}
			: {
					keyframes: { opacity: [0, 1], translateY: [4, 0], scale: [0.98, 1] },
					duration: MOTION.duration.surfaceIn,
					easing: MOTION.easing.standardTuple,
				},
	});
	cleanup(() => enterMotion.stop());
	return (
		<View
			testID="chat-composer-suggestions"
			class={`${menuPopupClass} min-w-0 overflow-hidden`}
			style={[
				menuPopupStyle(),
				enterMotion.style,
				{
					width: Math.min(props.width(), props.trigger() === "/" ? 520 : 600),
				},
			]}
		>
			{() =>
				props.trigger() === "@" ? (
					<MentionTabs
						tab={props.tab}
						categoryFocused={props.categoryFocused}
						onTab={props.onTab}
					/>
				) : null
			}
			<Scroll
				ref={(ref) => {
					list = ref;
				}}
				role="listbox"
				accessibilityLabel={title()}
				contentStyle={menuListSpacing()}
				bounces={false}
				// React's `min(18rem | 13rem, 40% of the viewport)`.
				style={{
					maxHeight: Math.min(
						props.trigger() === "/" ? 288 : 208,
						windowSize().height * 0.4,
					),
				}}
			>
				{() => {
					const entries = props.items();
					rows.length = 0;
					if (!entries.length) {
						return (
							<Text class="px-3 py-4 text-center font-sans text-xs text-muted-foreground">
								{() =>
									props.query()
										? t("chat.noSuggestionMatch", {
												query: props.query(),
												title: title(),
											})
										: t("chat.noSuggestionAvailable", { title: title() })
								}
							</Text>
						);
					}
					return entries.map((suggestion, i) => {
						const highlighted = () => i === props.index();
						const filePath =
							suggestion.kind === "file"
								? (fileMentionPath(suggestion.value) ?? suggestion.label)
								: null;
						return (
							<View
								ref={(ref) => {
									rows[i] = ref;
								}}
								testID={`chat-composer-suggestion:${i}`}
								role="option"
								accessibilityState={{ selected: highlighted() }}
								// Picked with the pointer, the focus stays in the input.
								focusable={false}
								class={`${menuRowClass} ${highlighted() ? "bg-hover" : ""}`}
								style={tactileTransition("background-color, color")}
								onMouseEnter={() => props.onHighlight(i)}
								onPress={() => props.onPick(suggestion)}
							>
								<View class="size-3.5 shrink-0 items-center justify-center">
									{filePath ? (
										<FileTypeIcon path={filePath} size={12} />
									) : (
										<Icon
											name={
												suggestion.skill
													? "Sparkles"
													: SUGGESTION_ICONS[suggestion.kind]
											}
											size={12}
											color={token("muted-foreground")}
										/>
									)}
								</View>
								<Text
									class={`min-w-0 flex-1 truncate text-xs ${
										suggestion.kind === "session" ? "font-sans" : "font-mono"
									} ${highlighted() ? "text-hover-foreground" : "text-foreground"}`}
								>
									{suggestion.label}
								</Text>
								{suggestion.detail ? (
									<Text class="min-w-0 max-w-[45%] shrink truncate font-sans text-xs text-muted-foreground">
										{suggestion.detail}
									</Text>
								) : null}
							</View>
						);
					});
				}}
			</Scroll>
		</View>
	);
}

export function ComposerKeyHint(props: { label: string }) {
	return (
		<View
			class="shrink-0 rounded-[4px] border border-border/70 bg-muted/50"
			style={{ paddingHorizontal: chatPx(4), paddingVertical: 1 }}
		>
			<Text class="font-mono text-muted-foreground" style={chatMetadataText}>
				{props.label}
			</Text>
		</View>
	);
}

/** The `@` menu's file and session tabs, with the Tab hint while they have the keys. */
export function MentionTabs(props: {
	tab: () => MentionTab;
	categoryFocused: () => boolean;
	onTab: (tab: MentionTab) => void;
}) {
	return (
		<View
			role="tablist"
			accessibilityLabel={t("chat.mentionCategories")}
			class="mb-1 flex-row items-center gap-1 px-1 pt-1"
		>
			{(["file", "session"] as const).map((tab) => {
				const hover = createHover();
				const active = () => props.tab() === tab;
				return (
					<View
						{...hover.props}
						testID={`chat-composer-mention-tab:${tab}`}
						role="tab"
						accessibilityState={{ selected: active() }}
						focusable={false}
						class={`h-7 shrink-0 flex-row items-center justify-center gap-1.5 rounded-md px-2.5 hover:bg-hover ${
							active() && props.categoryFocused() ? "bg-muted" : ""
						}`}
						onPress={() => props.onTab(tab)}
					>
						<Icon
							name={SUGGESTION_ICONS[tab]}
							size={14}
							color={token(
								active() || hover.hovered() ? "foreground" : "muted-foreground",
							)}
						/>
						<Text
							class={`font-sans text-xs font-medium ${
								active() || hover.hovered()
									? "text-foreground"
									: "text-muted-foreground"
							}`}
						>
							{() =>
								t(
									tab === "file"
										? "chat.fileSuggestion"
										: "chat.sessionSuggestion",
								)
							}
						</Text>
					</View>
				);
			})}
			{() =>
				props.categoryFocused() && platform.desktop ? (
					<View class="ml-auto min-w-0 shrink flex-row items-center gap-1.5 pl-2 pr-1">
						<ComposerKeyHint label="Tab" />
						<Text class="min-w-0 shrink truncate font-sans text-[11px] text-muted-foreground">
							{() => t("chat.mentionTabSwitchHint")}
						</Text>
					</View>
				) : null
			}
		</View>
	);
}

/** 统一单行附件芯片：上传图片、上传文件、`@文件` 与 `@会话` 共用同一套外观与交互。 */
export function AttachmentChip(props: {
	testID?: string;
	label: string;
	tooltip?: string;
	removeLabel: string;
	leading: JSX.Element;
	onPress?: () => void;
	disabled?: boolean;
	onRemove: () => void;
}) {
	const removeHover = createHover();
	const readingFont = ChatReadingFont();
	const openBlur = blurOnPointerPress();
	const removeBlur = blurOnPointerPress();
	return (
		<View
			testID={props.testID}
			class="min-w-0 flex-row items-center rounded-md bg-muted/60"
			style={{
				height: Math.max(chatPx(28), inputLineHeight(readingFont().fontSize)),
				maxWidth: chatPx(216),
			}}
		>
			<BaseButton
				ref={openBlur.ref}
				onMouseUp={openBlur.onMouseUp}
				class={`h-full min-w-0 flex-1 flex-row items-center rounded-l-md transition-colors focus-visible:outline-hidden ${props.onPress ? "hover:bg-hover" : ""}`}
				style={{
					gap: chatPx(6),
					paddingLeft: chatPx(8),
					paddingRight: chatPx(6),
					cursor: props.onPress ? "pointer" : "default",
				}}
				focusVisibleStyle={focusRingStyle(token("ring"))}
				accessibilityLabel={props.label}
				tooltip={
					props.tooltip ? (
						<Tooltip class="max-w-96" delay={250} margin={12}>
							<Text class="font-mono text-xs">{props.tooltip}</Text>
						</Tooltip>
					) : undefined
				}
				onPress={props.onPress}
			>
				{props.leading}
				<Text
					class="min-w-0 shrink truncate font-sans text-foreground"
					style={{ fontSize: chatPx(12) }}
				>
					{() => props.label}
				</Text>
			</BaseButton>
			<BaseButton
				ref={removeBlur.ref}
				onMouseUp={removeBlur.onMouseUp}
				class="h-full shrink-0 items-center justify-center rounded-r-md transition-colors hover:bg-hover focus-visible:outline-hidden"
				style={{ width: chatPx(24), cursor: "pointer" }}
				focusVisibleStyle={focusRingStyle(token("ring"))}
				accessibilityLabel={props.removeLabel}
				disabled={props.disabled}
				{...removeHover.props}
				onPress={props.onRemove}
			>
				<Icon
					name="X"
					size={chatPx(12)}
					color={token(
						removeHover.hovered() ? "foreground" : "muted-foreground",
					)}
				/>
			</BaseButton>
		</View>
	);
}
