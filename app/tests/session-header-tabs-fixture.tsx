import { computed, mount, signal, Text, View } from "nsh";

import type { WorkspaceFile } from "@shared/project-workspace";
import "../shell/fonts";
import { initializeI18n } from "../shell/i18n";
import { SessionHeader } from "../shell/session-header";
import type { TerminalTab } from "../state/terminal-store";
import { WorkspaceStore } from "../state/workspace-store";
import { Button } from "../ui/button";

const PROJECT_ID = "p1";

const SAMPLE_FILES: readonly WorkspaceFile[] = [
	{ path: "/work/demo/src/alpha.ts", content: "export const alpha = 1;" },
	{ path: "/work/demo/src/beta.ts", content: "export const beta = 2;" },
	{ path: "/work/demo/docs/gamma.md", content: "# Gamma" },
	{ path: "/work/demo/package.json", content: "{}" },
];

function Fixture() {
	const workspace = new WorkspaceStore();
	const terminals = signal<TerminalTab[]>([]);
	const activeTerminalId = signal<string | null>(null);

	const activeLabel = computed(() => {
		const termId = activeTerminalId();
		if (termId) return `active:terminal:${termId}`;
		if (workspace.isGitActive(PROJECT_ID)) return "active:git";
		const file = workspace.activeFile(PROJECT_ID);
		if (file) return `active:file:${file.file.path}`;
		return "active:chat";
	});

	const openMany = () => {
		workspace.openGit(PROJECT_ID);
		for (const file of SAMPLE_FILES) {
			workspace.openFile(PROJECT_ID, file);
		}
		terminals.set([
			{
				id: "t1",
				projectId: PROJECT_ID,
				title: "zsh",
				number: 1,
				exited: false,
			},
		]);
		// Keep chat selected initially so the overflow list deterministically holds tail items.
		activeTerminalId.set(null);
		workspace.selectChat(PROJECT_ID);
	};

	return (
		<View class="flex-1 flex-col bg-background">
			<View class="h-11 shrink-0 flex-row items-center border-b border-border/60 px-2">
				<SessionHeader
					title={() => "Refactor header tabs"}
					sessionId={() => "s1"}
					sessionPath={() => "/sessions/s1.jsonl"}
					showTitle={() => true}
					temporary={() => false}
					git={{
						open: () => workspace.isGitOpen(PROJECT_ID),
						active: () =>
							activeTerminalId() === null && workspace.isGitActive(PROJECT_ID),
						onSelect: () => {
							activeTerminalId.set(null);
							workspace.openGit(PROJECT_ID);
						},
						onClose: () => workspace.closeGit(PROJECT_ID),
					}}
					files={{
						tabs: () => workspace.files(PROJECT_ID),
						activePath: () =>
							activeTerminalId() === null
								? (workspace.activeFile(PROJECT_ID)?.file.path ?? null)
								: null,
						onSelect: (path) => {
							activeTerminalId.set(null);
							workspace.selectFile(PROJECT_ID, path);
						},
						onClose: (path) => workspace.closeFile(PROJECT_ID, path),
					}}
					terminals={{
						tabs: () => terminals(),
						activeId: () => activeTerminalId(),
						onSelect: (id) => {
							if (id !== null) workspace.selectChat(PROJECT_ID);
							activeTerminalId.set(id);
						},
						onClose: (id) => {
							terminals.update((list) => list.filter((item) => item.id !== id));
							if (activeTerminalId() === id) activeTerminalId.set(null);
						},
					}}
					onSelectChat={() => {
						activeTerminalId.set(null);
						workspace.selectChat(PROJECT_ID);
					}}
				/>
			</View>
			<View class="flex-1 flex-col gap-3 p-4">
				<Text testID="active-label" class="font-mono text-xs text-foreground">
					{activeLabel}
				</Text>
				<View class="flex-row gap-2">
					<Button testID="open-many" onPress={openMany}>
						<Text class="font-sans">Open many tabs</Text>
					</Button>
				</View>
			</View>
		</View>
	);
}

initializeI18n("en-US");
mount(Fixture);
