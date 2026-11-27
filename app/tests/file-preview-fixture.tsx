import { computed, mount, signal, Text, View } from "nsh";

import type { Project } from "@shared/api/projects-types";
import type { ChatMessage } from "@shared/chat/conversation-types";
import type { WorkspaceFile } from "@shared/project-workspace";
import { AppToaster, AppToasts, AppToastStack } from "../shell/app-toasts";
import { FilePreviewLayer } from "../shell/file-preview-view";
import { initializeI18n } from "../shell/i18n";
import {
	canOpenToolFilePath,
	openMarkdownFileLink,
	openToolFilePath,
} from "../shell/open-file-link";
import { SessionHeader } from "../shell/session-header";
import { ChatImageLightbox } from "../chat/chat-image-lightbox";
import { ChatMarkdown } from "../chat/chat-markdown";
import {
	ChatMediaActions,
	type ChatImagePreview,
} from "../chat/chat-media-actions";
import { ChatMessageList } from "../chat/chat-message-list";
import type { ChatTranscriptState } from "../state/chat-transcript-store";
import { WorkspaceStore } from "../state/workspace-store";
import { Button } from "../ui/button";

const png =
	"iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAATSURBVBhXY/iPA4S4uDgYGBgYAAAA//8DAI34Uw8AAAAASUVORK5CYII=";

function pngBytes(): Uint8Array {
	const binary = atob(png);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

const mainTsContent = Array.from(
	{ length: 120 },
	(_, index) => `export const line${index + 1} = ${index + 1};`,
).join("\n");

const notesMdContent = [
	"# Release Notes",
	"",
	"Line three detail with ![diagram](./shot.png).",
].join("\n");

const projects: Record<string, Pick<Project, "id" | "path">> = {
	p1: { id: "p1", path: "/work/demo" },
	p2: { id: "p2", path: "/work/other" },
};

const messages: ChatMessage[] = [
	{
		id: "m1",
		role: "user",
		text: "Open the files",
		time: "09:00",
	},
	{
		id: "m2",
		role: "assistant",
		text: "",
		time: "09:01",
		content: [
			{
				type: "thinking",
				id: "think-1",
				text: "Checking `src/main.ts:95` before editing.",
				status: "complete",
			},
			{
				type: "tool",
				id: "tool-edit",
				toolName: "edit",
				args: { path: "/work/demo/src/main.ts" },
				result: { details: { diff: "+export const line1 = 1;" } },
				status: "complete",
			},
			{
				type: "tool",
				id: "tool-read-img",
				toolName: "read",
				args: { path: "/work/demo/shot.png" },
				result: { content: [{ type: "text", text: "ok" }] },
				status: "complete",
			},
			{
				type: "text",
				id: "t1",
				text: [
					"Check [main lines](./src/main.ts#L15-L18), [line three](./src/main.ts#L3),",
					"[notes doc](./docs/notes.md), [notes line](./docs/notes.md#L3),",
					"[html report](./report.html), and [missing file](./missing.ts).",
					"Also inspect `src/main.ts:88-90` and plain src/main.ts:105.",
				].join(" "),
			},
		],
	},
];

async function run() {
	await initializeI18n();
	const currentProjectId = signal<"p1" | "p2">("p1");
	const project = computed(() => projects[currentProjectId()]);
	const workspace = new WorkspaceStore();
	const toasts = new AppToasts();
	const previewImage = signal<ChatImagePreview | null>(null);
	const openCalls = signal<string[]>([]);

	const previewFileLink = async (
		_projectId: string,
		url: string,
	): Promise<WorkspaceFile | null> => {
		openCalls.update((calls) => [...calls, `preview:${url}`]);
		if (url.endsWith("/missing.ts")) {
			throw new Error("ENOENT: missing.ts");
		}
		if (url.endsWith("/src/main.ts")) {
			return { path: "/work/demo/src/main.ts", content: mainTsContent };
		}
		if (url.endsWith("/docs/notes.md")) {
			return { path: "/work/demo/docs/notes.md", content: notesMdContent };
		}
		return null;
	};
	const openFileLink = async (_projectId: string, url: string) => {
		openCalls.update((calls) => [...calls, `sys:${url}`]);
	};

	const readProjectImage = async () => pngBytes();

	const fileContext = {
		project,
		workspace,
		previewFileLink,
		openFileLink,
		readProjectImage,
		openImage: (image: ChatImagePreview) => previewImage.set(image),
		toasts,
	};

	const openLink = (link: Parameters<typeof openMarkdownFileLink>[1]) =>
		openMarkdownFileLink(fileContext, link);

	const media = {
		openImage: (image: ChatImagePreview) => previewImage.set(image),
		project,
		onFileLink: openLink,
		canOpenFile: (path: string) => canOpenToolFilePath(fileContext, path),
		openFile: (path: string) => openToolFilePath(fileContext, path),
	};

	const state: ChatTranscriptState = {
		sessionKey: "file-preview-fixture",
		status: "ready",
		conversation: {
			messages,
			active: null,
			pendingUsers: [],
		},
		historyPrefix: [],
		source: "history",
	};

	const activeFile = computed(() => workspace.activeFile(project().id));

	mount(() => (
		<AppToaster.Provider value={toasts}>
			<ChatMediaActions.Provider value={media}>
				<View class="flex-1 flex-col bg-background">
					<View class="h-11 flex-row items-center border-b border-border px-2">
						<SessionHeader
							title={() => "Demo Session"}
							sessionId={() => "s1"}
							sessionPath={() => "/sessions/s1.jsonl"}
							showTitle={() => true}
							temporary={() => false}
							files={{
								tabs: () => workspace.files(project().id),
								activePath: () => activeFile()?.file.path ?? null,
								onSelect: (path) => workspace.selectFile(project().id, path),
								onClose: (path) => workspace.closeFile(project().id, path),
							}}
							onSelectChat={() => workspace.selectChat(project().id)}
							actions={
								<View class="flex-row items-center gap-1">
									<Button
										testID="switch-project"
										size="sm"
										variant="ghost"
										onPress={() =>
											currentProjectId.set(
												currentProjectId() === "p1" ? "p2" : "p1",
											)
										}
									>
										<Text class="font-sans text-xs">
											{() => `Project ${currentProjectId()}`}
										</Text>
									</Button>
								</View>
							}
						/>
					</View>
					<View class="relative min-h-0 flex-1">
						<ChatMessageList
							transcript={() => state}
							messages={() => messages}
							preferences={() => ({
								collapseCompletedActivity: false,
								showWorkDuration: false,
							})}
							assistantText={(text, textKey) => (
								<ChatMarkdown
									text={text}
									textKey={textKey}
									project={project}
									readProjectImage={readProjectImage}
									onFileLink={openLink}
								/>
							)}
						/>
						<FilePreviewLayer
							workspace={workspace}
							active={activeFile}
							projectFor={(id) => projects[id] ?? null}
							preferences={() => undefined}
							readProjectImage={readProjectImage}
							onFileLink={openLink}
						/>
					</View>
					<View class="border-t border-border px-2 py-1">
						<Text testID="open-calls" class="font-mono text-xs">
							{() => `calls:${openCalls().join("|")}`}
						</Text>
					</View>
					<ChatImageLightbox
						image={previewImage}
						onClose={() => previewImage.set(null)}
					/>
					<AppToastStack toasts={toasts} />
				</View>
			</ChatMediaActions.Provider>
		</AppToaster.Provider>
	));
}

await run();
