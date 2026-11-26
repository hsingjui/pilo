import {
	cleanup,
	computed,
	effect,
	Scroll,
	signal,
	Text,
	token,
	untracked,
	View,
} from "nsh";
import { Editor, type EditorDecoration, type EditorRef } from "nsh/base";

import type { Project } from "@shared/api/projects-types";
import { projectMarkdownImageScope } from "@shared/chat/chat-markdown-images";
import { fileLinkPreviewKind } from "@shared/chat/chat-markdown-links";
import { fileBasename } from "@shared/chat/chat-tool-result";
import { getMonospaceFontFamilyStack } from "@shared/font-settings";
import type { HostPreferenceValues } from "@shared/host-preferences-types";
import type {
	WorkspaceFile,
	WorkspaceLineRange,
} from "@shared/project-workspace";

import { ChatMarkdown, type ChatMarkdownFileLink } from "../chat/chat-markdown";
import type {
	ActiveWorkspaceFile,
	WorkspaceStore,
} from "../state/workspace-store";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { scrollbarLook, scrollbarTheme } from "../ui/scrollbar";
import { useEnterFade } from "../ui/motion";
import { t } from "./i18n";

const DEFAULT_CODE_FONT_SIZE = 12;

function resolveCodeFontSize(
	preferences: HostPreferenceValues | undefined,
): number {
	const fromPrefs = preferences?.codeFontSize;
	if (
		typeof fromPrefs === "number" &&
		Number.isFinite(fromPrefs) &&
		fromPrefs > 0
	) {
		return fromPrefs;
	}
	const fromToken = token("pilo-code-font-size");
	return typeof fromToken === "number" &&
		Number.isFinite(fromToken) &&
		fromToken > 0
		? fromToken
		: DEFAULT_CODE_FONT_SIZE;
}

function clampLineIndex(content: string, oneBasedLine: number): number {
	const lineCount = Math.max(1, content.split(/\r\n|\r|\n/).length);
	return Math.min(lineCount - 1, Math.max(0, oneBasedLine - 1));
}

function lineRangeDecorations(
	content: string,
	range: WorkspaceLineRange | undefined,
): EditorDecoration[] {
	if (!range) return [];
	const lines = content.split(/\r\n|\r|\n/);
	const maxLine = Math.max(0, lines.length - 1);
	const startLine = Math.min(maxLine, Math.max(0, range.start - 1));
	const endLine = Math.min(maxLine, Math.max(startLine, range.end - 1));
	const endColumn = lines[endLine]?.length ?? 0;
	return [
		{
			range: {
				start: { line: startLine, column: 0 },
				end: { line: endLine, column: endColumn },
			},
			lineClass: "bg-accent/20",
			gutter: {
				placement: "lines",
				class: "bg-primary",
			},
		},
	];
}

function FilePreviewPanel(props: {
	project: () => Pick<Project, "id" | "path"> | null;
	file: () => WorkspaceFile;
	visible: () => boolean;
	lineRange: () => WorkspaceLineRange | undefined;
	navigationToken: () => number;
	preferences: () => HostPreferenceValues | undefined;
	readProjectImage?: (projectId: string, path: string) => Promise<Uint8Array>;
	onFileLink?: (link: ChatMarkdownFileLink) => void;
}) {
	const filePath = untracked(props.file).path;
	const isMarkdown = fileLinkPreviewKind(filePath) === "markdown";
	// Markdown opens in rendered view, but jumps to source view with line numbers when targeted by lineRange.
	const showSource = signal(!isMarkdown || props.lineRange() !== undefined);
	let editorRef: EditorRef | undefined;
	let lastNavToken = -1;
	let pendingRevealFrame: number | null = null;

	const cancelPendingReveal = () => {
		if (pendingRevealFrame !== null) {
			cancelAnimationFrame(pendingRevealFrame);
			pendingRevealFrame = null;
		}
	};

	const revealTargetLine = (
		ref: EditorRef | undefined,
		range: WorkspaceLineRange | undefined,
		expectedNavToken?: number,
	) => {
		if (!ref || !range) return;
		const line = clampLineIndex(untracked(props.file).content, range.start);
		ref.goToLine(line);
		cancelPendingReveal();
		// Also scroll after layout settles (e.g. first mount or switching from `display: none`).
		pendingRevealFrame = requestAnimationFrame(() => {
			pendingRevealFrame = null;
			if (!untracked(props.visible)) return;
			if (
				expectedNavToken !== undefined &&
				untracked(props.navigationToken) !== expectedNavToken
			)
				return;
			if (editorRef !== ref) return;
			ref.goToLine(line);
		});
	};

	cleanup(cancelPendingReveal);

	effect(() => {
		if (!showSource()) {
			editorRef = undefined;
			cancelPendingReveal();
		}
	});

	effect(() => {
		const visible = props.visible();
		const range = props.lineRange();
		const navToken = props.navigationToken();
		if (!visible) return;
		if (navToken === lastNavToken) return;
		lastNavToken = navToken;
		if (isMarkdown) {
			const wantSource = range !== undefined;
			if (untracked(showSource) !== wantSource) {
				showSource.set(wantSource);
			}
		}
		if (range) {
			untracked(() => revealTargetLine(editorRef, range, navToken));
		}
	});

	const decorations = computed(() =>
		lineRangeDecorations(props.file().content, props.lineRange()),
	);
	const fontSize = computed(() => resolveCodeFontSize(props.preferences()));
	const lineHeight = computed(() => Math.max(22, Math.round(fontSize() * 1.7)));
	const lineNumberFontSize = computed(() => Math.max(11, fontSize() - 2));
	const imageBaseDirectory = computed(() => {
		const current = props.project();
		if (!current) return undefined;
		return (
			projectMarkdownImageScope(current, filePath)?.baseDirectory ?? undefined
		);
	});
	const fileName = fileBasename(filePath) || filePath;
	const fade = useEnterFade(props.visible);

	return (
		<View
			testID={`file-preview:${filePath}`}
			class="absolute inset-0 flex-col bg-background"
			style={[fade.style, { display: props.visible() ? "flex" : "none" }]}
		>
			<View
				testID="file-preview-toolbar"
				class="h-8 shrink-0 flex-row items-center justify-between gap-2 border-b border-border/60 bg-background/95 px-4"
			>
				<View selectable class="min-w-0 flex-1">
					<Text class="truncate font-mono text-[11px] text-muted-foreground">
						{filePath}
					</Text>
				</View>
				{isMarkdown ? (
					<Button
						testID="file-preview-toggle-source"
						variant="ghost"
						size="sm"
						class="h-6 shrink-0 gap-1 px-2"
						onPress={() => showSource.update((current) => !current)}
					>
						<Icon
							name={showSource() ? "Eye" : "Code2"}
							size={12}
							color={token("muted-foreground")}
						/>
						<Text class="font-sans text-[11px] text-muted-foreground">
							{() => t(showSource() ? "file.previewMode" : "file.sourceMode")}
						</Text>
					</Button>
				) : null}
			</View>
			{() =>
				showSource() ? (
					<Editor
						testID="file-preview-editor"
						ref={(node) => {
							editorRef = node;
							if (untracked(props.visible)) {
								revealTargetLine(
									node,
									untracked(props.lineRange),
									untracked(props.navigationToken),
								);
							}
						}}
						class="min-h-0 flex-1 bg-background"
						value={props.file().content}
						language={fileName}
						readOnly
						lineNumbers
						classes={{
							// nsh already offsets the gutter rows by the content's top padding.
							gutter: "bg-background pl-4 pr-3",
							lineNumber: "text-muted-foreground/40",
							activeLineNumber: "text-muted-foreground/80",
							content: "pl-2 pr-6 py-3",
						}}
						styles={{
							lineNumber: { fontSize: lineNumberFontSize() },
						}}
						folding={false}
						activeLine={false}
						scrollBeyondLastLine={false}
						fontFamily={getMonospaceFontFamilyStack(
							props.preferences()?.codeFontFamily ?? "system-mono",
						)}
						fontSize={fontSize()}
						lineHeight={lineHeight()}
						decorations={decorations()}
						accessibilityLabel={fileName}
					/>
				) : (
					<Scroll
						testID="file-preview-markdown"
						class="min-h-0 flex-1"
						contentClass="mx-auto w-full max-w-4xl p-6"
						bounces={false}
						scrollbar={scrollbarTheme({ vertical: scrollbarLook() })}
					>
						<ChatMarkdown
							text={() => props.file().content}
							textKey={() => `file:${filePath}`}
							project={props.project}
							imageBaseDirectory={imageBaseDirectory}
							readProjectImage={props.readProjectImage}
							onFileLink={props.onFileLink}
						/>
					</Scroll>
				)
			}
		</View>
	);
}

/**
 * Overlay layer for open project file previews; keeps chat mounted behind it
 * so switching tabs preserves the conversation scroll position.
 */
export function FilePreviewLayer(props: {
	workspace: WorkspaceStore;
	active: () => ActiveWorkspaceFile | null;
	projectFor: (projectId: string) => Pick<Project, "id" | "path"> | null;
	preferences: () => HostPreferenceValues | undefined;
	readProjectImage?: (projectId: string, path: string) => Promise<Uint8Array>;
	onFileLink?: (link: ChatMarkdownFileLink) => void;
}) {
	return (
		<View
			testID="file-preview-layer"
			class="absolute inset-0 z-30 bg-background"
			style={{ display: props.active() ? "flex" : "none" }}
		>
			<Each
				of={props.workspace.allOpenFiles()}
				key={(entry) => `${entry.projectId}:${entry.file.path}`}
			>
				{(entry) => {
					const current = untracked(entry);
					const isVisible = () => {
						const active = props.active();
						return (
							active !== null &&
							active.projectId === current.projectId &&
							active.file.path === current.file.path
						);
					};
					return (
						<FilePreviewPanel
							project={() => props.projectFor(current.projectId)}
							file={() => entry().file}
							visible={isVisible}
							lineRange={() =>
								isVisible() ? props.active()?.lineRange : undefined
							}
							navigationToken={() =>
								isVisible() ? (props.active()?.navigationToken ?? 0) : 0
							}
							preferences={props.preferences}
							readProjectImage={props.readProjectImage}
							onFileLink={props.onFileLink}
						/>
					);
				}}
			</Each>
		</View>
	);
}
