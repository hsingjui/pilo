import {
	cleanup,
	computed,
	effect,
	Image,
	openUrl,
	platform,
	signal,
	Text,
	token,
	untracked,
	View,
	type Signal,
} from "nsh";
import { TextView } from "nsh/base";
import type {
	TextViewCodeActionEvent,
	TextViewDocument,
	TextViewImage,
	TextViewLinkPressEvent,
	TextViewStyles,
} from "nsh/base";

import type { Project } from "@shared/api/projects-types";
import { resolveMarkdownImageSource } from "@shared/chat/chat-markdown-images";
import {
	createMarkdownFileLinkAnnotator,
	resolveChatFileLink,
} from "@shared/chat/chat-markdown-links";
import { bytesToBase64 } from "@shared/base64";
import {
	MAX_CHAT_IMAGE_BYTES,
	resolveChatImageMimeType,
} from "@shared/chat/chat-submission";
import { fileBasename } from "@shared/chat/chat-tool-result";
import { createStreamingMarkdownParser } from "@shared/chat/streaming-markdown-parser";
import { createStreamingTextThrottle } from "@shared/chat/streaming-text-throttle";
import type { WorkspaceLineRange } from "@shared/project-workspace";

import { AppToaster } from "../shell/app-toasts";
import { t } from "../shell/i18n";
import { ChatMediaActions, type ChatImagePreview } from "./chat-media-actions";
import { ChatReadingFont } from "./chat-reading-font";

/** What a project file link resolved to. */
export interface ChatMarkdownFileLink {
	url: string;
	lineRange?: WorkspaceLineRange;
}

export interface ChatMarkdownProps {
	/** The reply's Markdown, growing as it streams. */
	text: () => string;
	/** The text segment currently shown in a recycled message row. */
	textKey?: () => string;
	/** Whether the text is currently streaming in. */
	streaming?: () => boolean;
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
		keyboard: { fontSize: codeSize },
		codeBlock: { fontSize: codeSize, lineHeight: codeSize * 1.4 },
		table: text(0.92, 1.5),
	};
}

const INLINE_CODE_CLASS =
	"font-mono px-1.5 py-0.5 rounded-(--pilo-radius-sm) bg-foreground/[0.06] dark:bg-foreground/[0.09]";

type ProjectImageState =
	| { type: "loading" }
	| { type: "ready"; url: string; size: number }
	| { type: "error" };

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
 * (`options.streaming`). On Web, streaming deltas are throttled to avoid
 * rebuilding the trailing DOM subtree on every frame while flushing
 * immediately when settled or switching rows. External links open with
 * `openUrl`; file links and project images use the shared resolvers of
 * `shared/chat` — the same path limits and errors as the WebUI.
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
	const isStreaming = computed(() => props.streaming?.() ?? false);
	const web = platform.os === "web";
	let renderedText = props.text;
	if (web) {
		const displayedText = signal(untracked(props.text));
		const throttle = createStreamingTextThrottle({
			onCommit: (next) => displayedText.set(next),
		});
		effect(() => {
			const text = props.text();
			const streaming = isStreaming();
			const key = textKey();
			untracked(() => throttle.push(text, streaming, key));
		});
		cleanup(() => throttle.dispose());
		renderedText = displayedText;
	}
	const activeProject = computed(
		() => props.project?.() ?? media.project?.() ?? null,
	);
	const projectId = computed(() => activeProject()?.id);
	const projectPath = computed(() => activeProject()?.path);
	const fileLinkHandler = () => props.onFileLink ?? media.onFileLink;
	const parseStreamingDocument =
		createStreamingMarkdownParser<TextViewDocument>({
			parse: (text, streaming) => TextView.parse(text, { streaming }),
			createAnnotator: createMarkdownFileLinkAnnotator,
		});
	const document = computed<TextViewDocument>(() =>
		parseStreamingDocument({
			text: renderedText(),
			streaming: isStreaming(),
			key: textKey(),
			annotate: Boolean(fileLinkHandler()),
			projectPath: projectPath(),
		}),
	);
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
		const link = resolveChatFileLink(url, projectPath());
		if (link) fileLinkHandler()?.(link);
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
		if (source.type !== "project") {
			// Absolute image references reuse the file opener on click, not during streaming.
			const src = image.src;
			if (
				src &&
				/^(?:file:|\/(?!\/)|[a-z]:[\\/])/i.test(src) &&
				resolveChatImageMimeType({ name: src, type: "" })
			) {
				const link = resolveChatFileLink(src);
				if (link) fileLinkHandler()?.(link);
			}
			return;
		}
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
			// The root's font reaches every part: code keeps the bundled mono,
			// with pill padding and theme-adaptive tint (`nsh`'s default has no padding).
			classes={{
				code: INLINE_CODE_CLASS,
				codeBlockCode: "font-mono",
				keyboard: INLINE_CODE_CLASS,
			}}
			styles={styles()}
			selectable
			links="report"
			codeBlockActions={[{ id: "copy", label: t("chat.copyCode") }]}
			document={document()}
			onLinkPress={pressLink}
			onImagePress={(event) => pressImage(event.image)}
			onCodeBlockAction={handleCodeBlockAction}
			renderImage={renderImage}
		/>
	);
}
