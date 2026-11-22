import {
	computed,
	Image,
	openUrl,
	signal,
	Text,
	token,
	View,
	type Signal,
} from "nsh";
import { TextView } from "nsh/base";
import type {
	TextViewCodeActionEvent,
	TextViewImage,
	TextViewLinkPressEvent,
	TextViewStyles,
} from "nsh/base";

import type { Project } from "@shared/api/projects-types";
import { resolveMarkdownImageSource } from "@shared/chat/chat-markdown-images";
import { resolveMarkdownFileLink } from "@shared/chat/chat-markdown-links";
import { MAX_CHAT_IMAGE_BYTES } from "@shared/chat/chat-submission";
import { fileBasename } from "@shared/chat/chat-tool-result";
import type { WorkspaceLineRange } from "@shared/project-workspace";

import { AppToaster } from "../app/app-toasts";
import { t } from "../app/i18n";
import { ChatMediaActions, type ChatImagePreview } from "./chat-media-actions";
import { ChatReadingFont } from "./chat-reading-font";

/** What a project file link resolved to (`resolveMarkdownFileLink`). */
export interface ChatMarkdownFileLink {
	url: string;
	lineRange?: WorkspaceLineRange;
}

export interface ChatMarkdownProps {
	/** The reply's Markdown, growing as it streams. */
	text: () => string;
	/** The text segment currently shown in a recycled message row. */
	textKey?: () => string;
	/**
	 * The project the chat belongs to: project-relative file links and
	 * images resolve against its path; without it they render but cannot
	 * open or load.
	 */
	project?: () => Pick<Project, "id" | "path"> | null;
	/**
	 * The session file's directory under the project: the base `..` image
	 * paths resolve against (`projectMarkdownImageScope`'s baseDirectory).
	 */
	imageBaseDirectory?: () => string | undefined;
	/** Reads a project-relative image's bytes (`NshPiloClient.readProjectImage`). */
	readProjectImage?: (projectId: string, path: string) => Promise<Uint8Array>;
	/**
	 * What a resolved file link does when pressed (a workspace file tab,
	 * M5). Unresolvable links are ignored, like the WebUI's invalid-link
	 * path.
	 */
	onFileLink?: (link: ChatMarkdownFileLink) => void;
	/** What a press on an image not wrapped in a link does (defaults to ChatMediaActions.openImage). */
	onImagePress?: (image: ChatImagePreview) => void;
	/** The text's color; the reply's foreground without it. */
	class?: string;
	/**
	 * Thinking's typography (the WebUI's thinking details): tighter lines,
	 * headings at the text's size in medium weight.
	 */
	compact?: boolean;
}

/**
 * The WebUI's chat Markdown typography (`MARKDOWN_BASE_CLASSNAME`) at the
 * reading size, in place of `TextView`'s own fixed sizes (15pt text, 27, 20
 * and 17pt headings, 13pt code, 14pt tables), which ignored the font
 * settings and outweighed the rest of the page.
 */
function markdownStyles(
	fontFamily: string,
	size: number,
	codeSize: number,
	compact: boolean,
): TextViewStyles {
	const text = (scale: number, lineHeight: number) => ({
		fontSize: size * scale,
		lineHeight: size * scale * lineHeight,
	});
	const headings: TextViewStyles = compact
		? { heading: { ...text(1, 1.5), fontWeight: 500, letterSpacing: 0 } }
		: {
				heading1: { ...text(1.3, 1.35), letterSpacing: size * 1.3 * -0.025 },
				heading2: { ...text(1.15, 1.4), letterSpacing: size * 1.15 * -0.025 },
				heading3: { ...text(1, 1.5), letterSpacing: 0 },
				heading4: { ...text(1, 1.5), letterSpacing: 0 },
				heading5: {
					...text(0.92, 1.5),
					letterSpacing: size * 0.92 * 0.025,
					textTransform: "uppercase",
				},
				heading6: {
					...text(0.92, 1.5),
					letterSpacing: size * 0.92 * 0.025,
					textTransform: "uppercase",
				},
			};
	return {
		root: { fontFamily, ...text(1, compact ? 1.5 : 1.75) },
		...headings,
		code: { fontSize: codeSize },
		codeBlock: { fontSize: codeSize, lineHeight: codeSize * 1.4 },
		table: text(0.92, 1.5),
	};
}

type ProjectImageState =
	| { type: "loading" }
	| { type: "ready"; url: string; size: number }
	| { type: "error" };

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let index = 0; index < bytes.length; index += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	}
	return btoa(binary);
}

const MAX_INLINE_IMAGE_HEIGHT = 384;

function MarkdownImageFrame(props: {
	src: string;
	alt: string;
	width?: TextViewImage["width"];
	height?: TextViewImage["height"];
}) {
	const natural = signal<{ width: number; height: number } | null>(null);
	const sizeStyle = computed(() => {
		if (props.width !== undefined || props.height !== undefined) {
			return {
				width: props.width,
				height: props.height,
				maxWidth: "100%" as const,
				maxHeight: MAX_INLINE_IMAGE_HEIGHT,
			};
		}
		const size = natural();
		if (size && size.width > 0 && size.height > 0) {
			const scale =
				size.height > MAX_INLINE_IMAGE_HEIGHT
					? MAX_INLINE_IMAGE_HEIGHT / size.height
					: 1;
			return {
				width: Math.max(1, Math.round(size.width * scale)),
				height: Math.max(1, Math.round(size.height * scale)),
				maxWidth: "100%" as const,
				maxHeight: MAX_INLINE_IMAGE_HEIGHT,
			};
		}
		return {
			minWidth: 48,
			minHeight: 48,
			maxWidth: "100%" as const,
			maxHeight: MAX_INLINE_IMAGE_HEIGHT,
		};
	});
	return (
		<View
			testID="chat-markdown-image"
			accessible
			role="button"
			accessibilityLabel={t("chat.viewImage", { name: props.alt })}
			class="my-1 self-start overflow-hidden rounded-(--pilo-radius-lg) border border-foreground/10 bg-muted/40"
		>
			<Image
				src={props.src}
				accessibilityLabel={props.alt}
				onLoad={({ size }) => {
					if (size.width > 0 && size.height > 0) natural.set(size);
				}}
				style={{
					...sizeStyle(),
					objectFit: "contain",
				}}
			/>
		</View>
	);
}

/**
 * A reply as Markdown: `TextView` typesets it natively (headings, lists,
 * quotes, tables, syntax-highlighted code with a copy action, formulas)
 * and re-renders only the blocks that changed while the text streams in
 * (`options.streaming`), so no JS parser adapter or throttle is needed.
 * External links open with `openUrl`; file links and project images use
 * the shared resolvers of `shared/chat` — the same path limits and
 * errors as the WebUI.
 */
export function ChatMarkdown(props: ChatMarkdownProps) {
	const readingFont = ChatReadingFont();
	const toasts = AppToaster();
	const media = ChatMediaActions();
	const styles = computed(() =>
		markdownStyles(
			readingFont().fontFamily,
			readingFont().fontSize,
			token("pilo-code-font-size"),
			props.compact ?? false,
		),
	);
	const textKey = computed(() => props.textKey?.());
	const projectId = computed(() => props.project?.()?.id);
	// Keep a path's first read while streaming, not across recycled rows.
	const imageCache = computed(() => {
		textKey();
		return {
			projectId: projectId(),
			images: new Map<string, Signal<ProjectImageState>>(),
		};
	});
	const loadProjectImage = (
		state: Signal<ProjectImageState>,
		currentProjectId: string | undefined,
		path: string,
		mimeType: string,
	) => {
		const read = props.readProjectImage;
		if (!currentProjectId || !read) {
			state.set({ type: "error" });
			return;
		}
		state.set({ type: "loading" });
		void read(currentProjectId, path)
			.then((bytes) => {
				if (bytes.length > MAX_CHAT_IMAGE_BYTES) {
					throw new Error("image exceeds chat size limit");
				}
				state.set({
					type: "ready",
					url: `data:${mimeType};base64,${bytesToBase64(bytes)}`,
					size: bytes.length,
				});
			})
			.catch(() => state.set({ type: "error" }));
	};
	const projectImage = (path: string, mimeType: string) => {
		const { images, projectId: currentProjectId } = imageCache();
		const cached = images.get(path);
		if (cached) return cached;
		const state = signal<ProjectImageState>({ type: "loading" });
		images.set(path, state);
		loadProjectImage(state, currentProjectId, path, mimeType);
		return state;
	};
	const retryProjectImage = (path: string, mimeType: string) => {
		const { images, projectId: currentProjectId } = imageCache();
		let state = images.get(path);
		if (!state) {
			state = signal<ProjectImageState>({ type: "loading" });
			images.set(path, state);
		}
		loadProjectImage(state, currentProjectId, path, mimeType);
	};

	const fallback = (image: TextViewImage, retryable = false) => (
		<View class="my-1 rounded-(--pilo-radius-lg) border border-border bg-muted px-3 py-2">
			<Text class="font-sans text-xs text-muted-foreground">
				{image.alt
					? image.alt
					: t(retryable ? "chat.loadImageFailed" : "chat.imageUnavailable")}
			</Text>
		</View>
	);

	const pressLink = ({ url }: TextViewLinkPressEvent) => {
		if (/^(?:https?|mailto):/i.test(url)) {
			void openUrl(url);
			return;
		}
		const link = resolveMarkdownFileLink(url, props.project?.()?.path);
		if (link) props.onFileLink?.(link);
	};

	const openImagePreview = (preview: ChatImagePreview) => {
		const handler = props.onImagePress ?? media.openImage;
		handler?.(preview);
	};

	const pressImage = (image: TextViewImage) => {
		const source = resolveMarkdownImageSource(
			image.src,
			props.imageBaseDirectory?.(),
		);
		if (source.type === "external") {
			openImagePreview({
				url: source.url,
				name: image.alt || fileBasename(source.url) || t("chat.image"),
			});
			return;
		}
		if (source.type !== "project") return;
		const current = projectImage(source.path, source.mimeType)();
		if (current.type === "ready") {
			openImagePreview({
				url: current.url,
				name: fileBasename(source.path) || image.alt || t("chat.image"),
				size: current.size,
			});
		} else if (current.type === "error") {
			retryProjectImage(source.path, source.mimeType);
		}
	};

	const renderImage = (image: TextViewImage) => {
		const source = resolveMarkdownImageSource(
			image.src,
			props.imageBaseDirectory?.(),
		);
		const label = image.alt || t("chat.image");
		if (source.type === "external") {
			return (
				<MarkdownImageFrame
					src={source.url}
					alt={label}
					width={image.width}
					height={image.height}
				/>
			);
		}
		if (source.type !== "project") return fallback(image);
		const projectLabel =
			image.alt || fileBasename(source.path) || t("chat.image");
		return (
			<View>
				{() => {
					const current = projectImage(source.path, source.mimeType)();
					if (current.type === "ready") {
						return (
							<MarkdownImageFrame
								src={current.url}
								alt={projectLabel}
								width={image.width}
								height={image.height}
							/>
						);
					}
					if (current.type === "error") return fallback(image, true);
					return <View class="my-1 h-12 rounded-(--pilo-radius-lg) bg-muted" />;
				}}
			</View>
		);
	};

	const handleCodeBlockAction = (event: TextViewCodeActionEvent) => {
		if (event.id === "copy") {
			toasts?.show({ variant: "success", title: t("chat.copied") });
		}
	};

	return (
		<TextView
			class={props.class ?? "text-foreground"}
			// The root's font reaches every part: code keeps the bundled mono.
			classes={{
				code: "font-mono",
				codeBlockCode: "font-mono",
				keyboard: "font-mono",
			}}
			styles={styles()}
			selectable
			links="report"
			codeBlockActions={[{ id: "copy", label: t("chat.copyCode") }]}
			markdown={props.text()}
			options={{ streaming: true }}
			onLinkPress={pressLink}
			onImagePress={(event) => pressImage(event.image)}
			onCodeBlockAction={handleCodeBlockAction}
			renderImage={renderImage}
		/>
	);
}
