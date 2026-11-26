import { colorScheme, Image, Text, token, View } from "nsh";
import { Button as BaseButton } from "nsh/base";

import { createHover } from "../ui/hover";
import { FileTypeIcon, fileTypePresentation } from "../ui/file-type-icon";
import { Icon } from "../ui/icon";
import { Tooltip } from "../ui/tooltip";
import { chatPx } from "./layout";

export type InlineMentionKind = "file" | "session" | "image";

/** 输入框与消息气泡共用的内联引用文本配色，参考亮/暗高对比青蓝/类型色风格。 */
export function inlineMentionColor(kind: InlineMentionKind, path: string) {
	if (kind === "session") {
		return colorScheme() === "dark" ? "#38bdf8" : "#0e7490";
	}
	if (kind === "image") {
		return colorScheme() === "dark" ? "#c084fc" : "#9333ea";
	}
	const presentation = fileTypePresentation(path);
	if (presentation.kind === "file") {
		return colorScheme() === "dark" ? "#38bdf8" : "#0e7490";
	}
	return presentation.color;
}

/**
 * 内联 `@文件` / `@会话` / 上传图片展示单元（图标或小缩略图 + 名称 + 悬停完整路径/详情 + 可点击态）。
 * 既用于 `RichEditor` 的原子节点视图，也用于已发送用户消息气泡正文。
 */
export function ChatMentionInline(props: {
	kind: InlineMentionKind;
	label: string;
	path: string;
	detail?: string;
	imageUrl?: string;
	fontSize: number;
	fontFamily?: string;
	selected?: boolean;
	interactive?: boolean;
	testID?: string;
	accessibilityLabel?: string;
	onPress?: () => void;
	onRemove?: () => void;
	removeLabel?: string;
	disabled?: boolean;
}) {
	const hover = createHover();
	const removeHover = createHover();
	const interactive = () => props.interactive ?? Boolean(props.onPress);
	const accentColor = () => inlineMentionColor(props.kind, props.path);
	const iconSize = () =>
		Math.max(chatPx(13), Math.round(props.fontSize * 0.92));
	const tooltipText = () => {
		if (props.kind === "image") {
			return props.detail ? `${props.label} · ${props.detail}` : props.label;
		}
		return props.detail ? `${props.detail}\n${props.path}` : props.path;
	};
	return (
		<View
			testID={props.testID}
			role={interactive() && !props.onRemove ? "button" : undefined}
			accessible={!props.onRemove}
			accessibilityLabel={props.accessibilityLabel ?? props.label}
			{...hover.props}
			onPress={interactive() ? props.onPress : undefined}
			class={`max-w-full flex-row items-center rounded-[4px] transition-colors ${
				props.selected
					? "bg-primary/15"
					: interactive() && hover.hovered()
						? "bg-muted/70"
						: props.onRemove
							? "bg-muted/55"
							: ""
			}`}
			style={{
				gap: chatPx(4),
				paddingLeft: chatPx(4),
				paddingRight: props.onRemove ? chatPx(2) : chatPx(4),
				paddingVertical: 1,
				cursor: interactive() ? "pointer" : "default",
				verticalAlign: "middle",
			}}
			tooltip={
				<Tooltip class="max-w-96" delay={250} margin={12}>
					<Text class="font-mono text-xs">{tooltipText}</Text>
				</Tooltip>
			}
		>
			{props.kind === "session" ? (
				<Icon name="MessageSquare" size={iconSize()} color={accentColor()} />
			) : props.kind === "image" ? (
				props.imageUrl ? (
					<Image
						src={props.imageUrl}
						class="shrink-0 overflow-hidden rounded-[3px] border border-foreground/10"
						style={{
							width: iconSize(),
							height: iconSize(),
							objectFit: "cover",
						}}
					/>
				) : (
					<Icon name="FileImage" size={iconSize()} color={accentColor()} />
				)
			) : (
				<FileTypeIcon
					path={props.path}
					size={iconSize()}
					color={accentColor()}
				/>
			)}
			<Text
				class="min-w-0 shrink truncate font-sans"
				style={{
					fontSize: props.fontSize,
					fontFamily: props.fontFamily,
					color: accentColor(),
					textDecorationLine:
						interactive() && hover.hovered() ? "underline" : "none",
				}}
			>
				{props.label}
			</Text>
			{props.onRemove ? (
				<BaseButton
					{...removeHover.props}
					class="ml-0.5 items-center justify-center rounded-[3px] transition-colors hover:bg-hover"
					style={{
						width: Math.max(chatPx(16), Math.round(props.fontSize * 1.15)),
						height: Math.max(chatPx(16), Math.round(props.fontSize * 1.15)),
						cursor: props.disabled ? "default" : "pointer",
					}}
					disabled={props.disabled}
					accessibilityLabel={props.removeLabel ?? props.label}
					onPress={() => {
						if (!props.disabled) props.onRemove?.();
					}}
				>
					<Icon
						name="X"
						size={chatPx(11)}
						color={token(
							removeHover.hovered() ? "foreground" : "muted-foreground",
						)}
					/>
				</BaseButton>
			) : null}
		</View>
	);
}
