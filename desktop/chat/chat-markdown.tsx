import { Image, openUrl, signal, Text, View, type Signal } from "nsh";
import { TextView } from "nsh/base";
import type { TextViewImage, TextViewLinkPressEvent } from "nsh/base";

import type { Project } from "@shared/api/projects-types";
import { resolveMarkdownImageSource } from "@shared/chat/chat-markdown-images";
import { resolveMarkdownFileLink } from "@shared/chat/chat-markdown-links";
import { MAX_CHAT_IMAGE_BYTES } from "@shared/chat/chat-submission";
import type { WorkspaceLineRange } from "@shared/project-workspace";

import { t } from "../app/i18n";

/** What a project file link resolved to (`resolveMarkdownFileLink`). */
export interface ChatMarkdownFileLink {
	url: string;
	lineRange?: WorkspaceLineRange;
}

export interface ChatMarkdownProps {
	/** The reply's Markdown, growing as it streams. */
	text: () => string;
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
	/** What a press on an image not wrapped in a link does (preview, M5). */
	onImagePress?: (image: TextViewImage) => void;
	/** The text's size and color; the reply's body without it. */
	class?: string;
}

type ProjectImageState =
	| { type: "loading" }
	| { type: "ready"; url: string }
	| { type: "error" };

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let index = 0; index < bytes.length; index += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	}
	return btoa(binary);
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
	// A data: URL per project-relative image path, read once and kept.
	const images = new Map<string, Signal<ProjectImageState>>();
	const projectImage = (path: string, mimeType: string) => {
		let state = images.get(path);
		if (state) return state;
		state = signal<ProjectImageState>({ type: "loading" });
		images.set(path, state);
		const project = props.project?.();
		const read = props.readProjectImage;
		if (!project || !read) {
			state.set({ type: "error" });
			return state;
		}
		void read(project.id, path)
			.then((bytes) => {
				if (bytes.length > MAX_CHAT_IMAGE_BYTES) {
					throw new Error("image exceeds chat size limit");
				}
				state!.set({
					type: "ready",
					url: `data:${mimeType};base64,${bytesToBase64(bytes)}`,
				});
			})
			.catch(() => state!.set({ type: "error" }));
		return state;
	};

	const fallback = (image: TextViewImage) => (
		<View class="my-1 rounded-(--pilo-radius-lg) border border-border bg-muted px-3 py-2">
			<Text class="font-sans text-xs text-muted-foreground">
				{image.alt ? image.alt : t("chat.imageUnavailable")}
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

	const renderImage = (image: TextViewImage) => {
		const source = resolveMarkdownImageSource(
			image.src,
			props.imageBaseDirectory?.(),
		);
		if (source.type === "external") {
			return (
				<Image
					src={source.url}
					accessibilityLabel={image.alt}
					style={{
						width: image.width,
						height: image.height,
						maxWidth: "100%",
					}}
				/>
			);
		}
		if (source.type !== "project") return fallback(image);
		const state = projectImage(source.path, source.mimeType);
		return (
			<View>
				{() => {
					const current = state();
					if (current.type === "ready") {
						return (
							<Image
								src={current.url}
								accessibilityLabel={image.alt}
								style={{
									width: image.width,
									height: image.height,
									maxWidth: "100%",
								}}
							/>
						);
					}
					if (current.type === "error") return fallback(image);
					return <View class="my-1 h-12 rounded-(--pilo-radius-lg) bg-muted" />;
				}}
			</View>
		);
	};

	return (
		<TextView
			class={props.class ?? "font-sans text-base text-foreground"}
			// The root's font reaches every part: code keeps the bundled mono.
			classes={{
				code: "font-mono",
				codeBlockCode: "font-mono",
				keyboard: "font-mono",
			}}
			selectable
			links="report"
			codeBlockActions={[{ id: "copy" }]}
			markdown={props.text()}
			options={{ streaming: true }}
			onLinkPress={pressLink}
			onImagePress={(event) => props.onImagePress?.(event.image)}
			renderImage={renderImage}
		/>
	);
}
