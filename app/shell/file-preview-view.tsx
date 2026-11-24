import {
	Clipboard,
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
import {
	workspaceFileKey,
	type WorkspaceFile,
	type WorkspaceLineRange,
} from "@shared/project-workspace";

import { ChatMarkdown, type ChatMarkdownFileLink } from "../chat/chat-markdown";
import type {
	ActiveWorkspaceFile,
	WorkspaceStore,
} from "../state/workspace-store";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { scrollbarLook } from "../ui/scrollbar";
import { Tooltip } from "../ui/tooltip";
import { AppToaster, showToast } from "./app-toasts";
import { t } from "./i18n";

function displayFilePath(
	filePath: string,
	projectPath: string | undefined,
): string {
	if (!projectPath) return filePath;
	const root = workspaceFileKey(projectPath).replace(/\/+$/, "");
	const normalized = workspaceFileKey(filePath);
	if (normalized.startsWith(`${root}/`)) {
		return filePath.slice(root.length + 1);
	}
	return filePath;
}

function formatLineRangeBadge(range: WorkspaceLineRange): string {
	return range.start === range.end
		? `L${range.start}`
		: `L${range.start}-L${range.end}`;
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
	file: WorkspaceFile;
	visible: () => boolean;
	lineRange: () => WorkspaceLineRange | undefined;
	navigationToken: () => number;
	preferences: () => HostPreferenceValues | undefined;
	readProjectImage?: (projectId: string, path: string) => Promise<Uint8Array>;
	onFileLink?: (link: ChatMarkdownFileLink) => void;
}) {
	const toasts = AppToaster();
	const isMarkdown = fileLinkPreviewKind(props.file.path) === "markdown";
	// Markdown opens in rendered view, but jumps to source view with line numbers when targeted by lineRange.
	const showSource = signal(!isMarkdown || props.lineRange() !== undefined);
	let editorRef: EditorRef | undefined;
	let lastNavToken = -1;

	const revealTargetLine = (
		ref: EditorRef | undefined,
		range: WorkspaceLineRange | undefined,
	) => {
		if (!ref || !range) return;
		const line = clampLineIndex(props.file.content, range.start);
		ref.goToLine(line);
	};

	effect(() => {
		const visible = props.visible();
		const range = props.lineRange();
		const navToken = props.navigationToken();
		if (!visible || navToken === lastNavToken) return;
		lastNavToken = navToken;
		if (range) {
			if (isMarkdown && !untracked(showSource)) {
				showSource.set(true);
			}
			untracked(() => revealTargetLine(editorRef, range));
		}
	});

	const decorations = computed(() =>
		lineRangeDecorations(props.file.content, props.lineRange()),
	);
	const labelPath = computed(() =>
		displayFilePath(props.file.path, props.project()?.path),
	);
	const imageBaseDirectory = computed(() => {
		const current = props.project();
		if (!current) return undefined;
		return (
			projectMarkdownImageScope(current, props.file.path)?.baseDirectory ??
			undefined
		);
	});
	const fileName = fileBasename(props.file.path) || props.file.path;

	const copyContent = () => {
		void Clipboard.writeText(props.file.content)
			.then(() =>
				showToast(toasts, { variant: "success", title: t("chat.copied") }),
			)
			.catch(() =>
				showToast(toasts, { variant: "error", title: t("chat.copyFailed") }),
			);
	};

	return (
		<View
			testID={`file-preview:${props.file.path}`}
			class="absolute inset-0 flex-col bg-background"
			style={{ display: props.visible() ? "flex" : "none" }}
		>
			<View class="h-9 shrink-0 flex-row items-center justify-between gap-2 border-b border-border/70 px-3">
				<View class="min-w-0 flex-1 flex-row items-center gap-2">
					<Text
						testID="file-preview-path"
						class="min-w-0 shrink truncate font-mono text-xs text-muted-foreground"
					>
						{labelPath}
					</Text>
					{() => {
						const range = props.lineRange();
						return range ? (
							<View
								testID="file-preview-line-range"
								class="shrink-0 rounded-sm bg-muted px-1.5 py-0.5"
							>
								<Text class="font-mono text-xs tabular-nums text-foreground">
									{formatLineRangeBadge(range)}
								</Text>
							</View>
						) : null;
					}}
				</View>
				<View class="shrink-0 flex-row items-center gap-1">
					{isMarkdown ? (
						<Button
							testID="file-preview-toggle-source"
							variant="ghost"
							size="sm"
							class="h-7 px-2"
							onPress={() => showSource.update((value) => !value)}
						>
							<Icon
								name={showSource() ? "Eye" : "Code2"}
								size={14}
								color={token("muted-foreground")}
							/>
							<Text class="font-sans text-xs text-muted-foreground">
								{() =>
									t(showSource() ? "file.previewMarkdown" : "file.viewSource")
								}
							</Text>
						</Button>
					) : null}
					<Button
						testID="file-preview-copy"
						variant="ghost"
						size="icon"
						class="size-7"
						accessibilityLabel={t("chat.copy")}
						tooltip={
							<Tooltip>
								<Text class="font-sans">{() => t("chat.copy")}</Text>
							</Tooltip>
						}
						onPress={copyContent}
					>
						<Icon name="Copy" size={14} color={token("muted-foreground")} />
					</Button>
				</View>
			</View>
			{() =>
				showSource() ? (
					<Editor
						testID="file-preview-editor"
						ref={(node) => {
							editorRef = node;
							if (untracked(props.visible)) {
								revealTargetLine(node, untracked(props.lineRange));
							}
						}}
						class="min-h-0 flex-1 bg-background"
						value={props.file.content}
						language={fileName}
						readOnly
						lineNumbers
						classes={{
							gutter: "bg-muted/50",
							lineNumber: "text-muted-foreground",
						}}
						folding={false}
						activeLine={false}
						scrollBeyondLastLine={false}
						fontFamily={getMonospaceFontFamilyStack(
							props.preferences()?.codeFontFamily ?? "system-mono",
						)}
						fontSize={token("pilo-code-font-size")}
						decorations={decorations()}
						accessibilityLabel={fileName}
					/>
				) : (
					<Scroll
						testID="file-preview-markdown"
						class="min-h-0 flex-1"
						contentClass="mx-auto w-full max-w-4xl p-6"
						bounces={false}
						scrollbar={{ vertical: scrollbarLook() }}
					>
						<ChatMarkdown
							text={() => props.file.content}
							textKey={() => `file:${props.file.path}`}
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
							file={current.file}
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
