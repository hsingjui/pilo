import { computed, Text, token, View } from "nsh";
import { Button as BaseButton } from "nsh/base";

import type { ToolCallActivity } from "@shared/chat/chat-activity-types";
import {
	fileBasename,
	isRecord,
	singleToolResultImage,
	toolFilePath,
	toolPreview,
	toolResultImageUrl,
} from "@shared/chat/chat-tool-result";
import {
	countChatTodos,
	isChatTodoTool,
	parseChatTodos,
} from "@shared/chat/chat-todos";

import { t } from "../app/i18n";
import { classNames } from "../ui/class-names";
import { blurOnPointerPress, focusRingStyle } from "../ui/focus-ring-style";
import { Foreground } from "../ui/foreground";
import { Icon } from "../ui/icon";
import { Spinner } from "../ui/spinner";
import { Tooltip } from "../ui/tooltip";
import { toolIconName, toolLabel, toolSkillName } from "./chat-activity-labels";
import { ChatDisclosureRow } from "./chat-disclosure-row";
import { ChatDisclosureAction, type ChatExpansion } from "./chat-expansion";
import { ChatMediaActions } from "./chat-media-actions";
import { ChatReadingFont, readingTextStyle } from "./chat-reading-font";
import { ChatToolDetail } from "./chat-tool-detail";

/**
 * One tool call: its icon, what it is and what it acted on (a file's name,
 * a command, a task count), a spinner while it runs or a mark when it
 * failed. It opens to its details, closed until the user opens it.
 */
export function ChatToolActivity(props: {
	activity: () => ToolCallActivity;
	expansion: ChatExpansion;
	expansionKey: () => string;
}) {
	const { activity } = props;
	const readingFont = ChatReadingFont();
	const media = ChatMediaActions();
	const disclose = ChatDisclosureAction();
	const open = computed(() =>
		props.expansion.isOpen(props.expansionKey(), false),
	);
	const running = computed(() => activity().status === "running");
	const failed = computed(() => activity().isError === true);
	const preview = computed(() => toolPreview(activity()));
	const filePath = computed(() => toolFilePath(activity()));
	const toolName = computed(() => activity().toolName.toLowerCase());
	const readImage = computed(() =>
		toolName() === "read" && !running() && !failed() && filePath()
			? singleToolResultImage(activity().result)
			: null,
	);
	const openablePath = computed(() => {
		const path = filePath();
		const name = toolName();
		if ((name !== "read" && name !== "write" && name !== "edit") || !path) {
			return null;
		}
		if (readImage() && media.openImage) return path;
		if (media.openFile && (media.canOpenFile?.(path) ?? true)) return path;
		return null;
	});
	const skillName = computed(() => toolSkillName(activity(), filePath()));
	// A failed call's list did not take effect: its details show the error.
	const todos = computed(() => {
		const current = activity();
		return !current.isError && isChatTodoTool(current.toolName)
			? parseChatTodos(current.args, current.result)
			: null;
	});
	const writeContent = computed(() => {
		const { toolName, args } = activity();
		return toolName.toLowerCase() === "write" &&
			isRecord(args) &&
			typeof args.content === "string"
			? args.content
			: null;
	});
	const label = computed(() =>
		skillName() ? t("chat.skill") : toolLabel(activity().toolName),
	);
	const previewLabel = computed(() => {
		const list = todos();
		if (list) {
			return t("chat.todoProgress", {
				done: countChatTodos(list).completed,
				total: list.length,
			});
		}
		const path = filePath();
		return skillName() ?? (path ? fileBasename(path) : preview());
	});
	const hasDetails = computed(() => {
		const { args, result } = activity();
		return (
			todos() !== null ||
			writeContent() !== null ||
			(args !== undefined && args !== null && preview() === null) ||
			(result !== undefined && result !== null)
		);
	});
	const detailKey = computed(() =>
		hasDetails() && open() ? props.expansionKey() : null,
	);
	const status = computed(() =>
		failed() ? "failed" : running() ? "running" : null,
	);
	const toggleDetails = () => {
		if (!hasDetails()) return;
		disclose(() => props.expansion.setOpen(props.expansionKey(), !open()));
	};
	const openPath = () => {
		const path = openablePath();
		if (!path) return;
		const image = readImage();
		if (image && media.openImage) {
			media.openImage({
				url: toolResultImageUrl(image),
				name: fileBasename(path) || path,
			});
			return;
		}
		media.openFile?.(path);
	};
	const rowColor = () => token(failed() ? "destructive" : "muted-foreground");
	return (
		<View class="w-full">
			{() => {
				const path = openablePath();
				const value = previewLabel();
				if (path && value) {
					const labelBlur = blurOnPointerPress();
					const linkBlur = blurOnPointerPress();
					const tailBlur = blurOnPointerPress();
					return (
						<Foreground.Provider value={rowColor}>
							<View
								testID="chat-tool"
								class={classNames(
									"-mx-1 min-h-6 flex-row items-center gap-1.5 rounded-(--pilo-radius-md) px-1 py-0.5",
									hasDetails() ? "hover:bg-hover" : undefined,
									open() ? "bg-hover" : undefined,
								)}
							>
								<BaseButton
									disabled={!hasDetails()}
									ref={labelBlur.ref}
									onMouseUp={labelBlur.onMouseUp}
									class="shrink-0 flex-row items-center gap-1.5 focus-visible:outline-hidden"
									focusVisibleStyle={focusRingStyle(token("ring"))}
									accessibilityLabel={`${label()} ${value}`}
									onPress={toggleDetails}
								>
									<Icon
										name={toolIconName(
											activity().toolName,
											skillName() !== null,
										)}
										size={14}
									/>
									<Text
										class={
											failed()
												? "shrink-0 font-sans font-medium leading-snug text-destructive"
												: "shrink-0 font-sans font-medium leading-snug text-muted-foreground"
										}
										style={readingTextStyle(readingFont())}
									>
										{label}
									</Text>
								</BaseButton>
								<BaseButton
									testID="chat-tool-file-link"
									ref={linkBlur.ref}
									onMouseUp={linkBlur.onMouseUp}
									class="min-w-0 shrink rounded-sm bg-muted/50 px-1.5 py-0.5 hover:bg-muted focus-visible:outline-hidden"
									focusVisibleStyle={focusRingStyle(token("ring"))}
									accessibilityLabel={t("chat.openFile", { path })}
									tooltip={
										<Tooltip class="max-w-96" delay={300} margin={16}>
											<Text class="font-mono text-xs">{path}</Text>
										</Tooltip>
									}
									onPress={openPath}
								>
									<Text
										class="min-w-0 truncate font-mono font-normal text-muted-foreground"
										style={{ fontSize: token("pilo-code-font-size") }}
									>
										{value}
									</Text>
								</BaseButton>
								<BaseButton
									disabled={!hasDetails()}
									ref={tailBlur.ref}
									onMouseUp={tailBlur.onMouseUp}
									class="min-h-5 min-w-2 flex-1 flex-row items-center justify-end focus-visible:outline-hidden"
									accessibilityLabel={`${label()} ${value}`}
									onPress={toggleDetails}
								>
									{() =>
										status() === "failed" ? (
											<Icon name="CircleAlert" size={14} />
										) : status() === "running" ? (
											<Spinner size={14} />
										) : null
									}
								</BaseButton>
							</View>
						</Foreground.Provider>
					);
				}
				return (
					<ChatDisclosureRow
						testID="chat-tool"
						tone={failed() ? "destructive" : "muted"}
						expanded={hasDetails() ? open() : undefined}
						disabled={!hasDetails()}
						class={open() ? "bg-hover" : undefined}
						accessibilityLabel={
							previewLabel() ? `${label()} ${previewLabel()}` : label()
						}
						tooltip={
							preview() ? (
								<Tooltip class="max-w-80" delay={300} margin={16}>
									<Text class="line-clamp-24 font-sans">
										{() => preview() ?? ""}
									</Text>
								</Tooltip>
							) : undefined
						}
						onPress={() =>
							props.expansion.setOpen(props.expansionKey(), !open())
						}
					>
						{() => (
							<Icon
								name={toolIconName(activity().toolName, skillName() !== null)}
								size={14}
							/>
						)}
						<Text
							class={
								failed()
									? "min-w-0 flex-1 truncate font-sans font-medium leading-snug text-destructive"
									: "min-w-0 flex-1 truncate font-sans font-medium leading-snug text-muted-foreground"
							}
							style={readingTextStyle(readingFont())}
						>
							{label}
							<Text
								class="font-mono font-normal text-muted-foreground"
								style={{ fontSize: token("pilo-code-font-size") }}
							>
								{() => {
									const value = previewLabel();
									return value ? `\u2002${value}` : "";
								}}
							</Text>
						</Text>
						{() =>
							status() === "failed" ? (
								<Icon name="CircleAlert" size={14} />
							) : status() === "running" ? (
								<Spinner size={14} />
							) : null
						}
					</ChatDisclosureRow>
				);
			}}
			{() => {
				// A recycled row must not carry its detail scroll into another call.
				if (detailKey() === null) return null;
				return (
					<ChatToolDetail
						activity={activity}
						writeContent={writeContent}
						todos={todos}
					/>
				);
			}}
		</View>
	);
}
