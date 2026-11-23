import { computed, mount, signal, Text, View } from "nsh";

import type { Project } from "@shared/api/projects-types";
import type { WorkspaceFile } from "@shared/project-workspace";
import "../shell/fonts";
import { AppToaster, AppToasts, AppToastStack } from "../shell/app-toasts";
import { FilePreviewLayer } from "../shell/file-preview-view";
import {
	GitWorkspaceLayer,
	type GitWorkspaceClient,
} from "../shell/git-workspace-view";
import { HeaderActions } from "../shell/header-actions";
import { initializeI18n } from "../shell/i18n";
import { canOpenToolFilePath, openToolFilePath } from "../shell/open-file-link";
import { SessionHeader } from "../shell/session-header";
import type { GitStatus } from "../client/nsh-pilo-client";
import { WorkspaceStore } from "../state/workspace-store";
import { Button } from "../ui/button";

const STANDARD_DIFF = [
	"diff --git a/src/app.ts b/src/app.ts",
	"index 1111111..2222222 100644",
	"--- a/src/app.ts",
	"+++ b/src/app.ts",
	"@@ -1,3 +1,4 @@",
	" export function greet(name: string) {",
	"-  return `Hello ${name}`;",
	"+  const trimmed = name.trim();",
	"+  return `Hello, ${trimmed}!`;",
	" }",
].join("\n");

const UNTRACKED_DIFF = [
	"diff --git a/dev/null b/notes.md",
	"new file mode 100644",
	"index 0000000..3333333",
	"--- /dev/null",
	"+++ b/notes.md",
	"@@ -0,0 +1,2 @@",
	"+# Notes",
	"+New untracked note",
].join("\n");

const STAGED_DIFF = [
	"diff --git a/src/staged.ts b/src/staged.ts",
	"index 4444444..5555555 100644",
	"--- a/src/staged.ts",
	"+++ b/src/staged.ts",
	"@@ -1,1 +1,1 @@",
	"-export const version = 1;",
	"+export const version = 2;",
].join("\n");

const TRUNCATED_DIFF = [
	"diff --git a/src/truncated.ts b/src/truncated.ts",
	"--- a/src/truncated.ts",
	"+++ b/src/truncated.ts",
	"@@ -1,5 +1,5 @@",
	"-only one line before truncation",
].join("\n");

const BINARY_DIFF = [
	"diff --git a/assets/logo.png b/assets/logo.png",
	"index 1111111..2222222 100644",
	"Binary files a/assets/logo.png and b/assets/logo.png differ",
].join("\n");

const COMBINED_DIFF = [
	"diff --cc src/conflict.ts",
	"index 1111111,2222222..0000000",
	"--- a/src/conflict.ts",
	"+++ b/src/conflict.ts",
	"@@@ -1,1 -1,1 +1,5 @@@",
	"++<<<<<<< HEAD",
	" +const x = 1;",
	"++=======",
	"+ const x = 2;",
	"++>>>>>>> branch",
].join("\n");

const projects: Record<"p1" | "p2", Project> = {
	p1: {
		id: "p1",
		name: "Demo",
		path: "/work/demo",
		connection: {
			id: "local",
			name: "Local",
			kind: { type: "local" },
			shownInHome: true,
		},
		metadata: {
			cwd: "/work/demo",
			gitBranch: "feat/git-panel",
			piVersion: "1.0.0",
			refreshedAtMs: 0,
		},
		createdAtMs: 0,
		lastOpenedAtMs: 0,
	},
	p2: {
		id: "p2",
		name: "Other",
		path: "/work/other",
		connection: {
			id: "local",
			name: "Local",
			kind: { type: "local" },
			shownInHome: true,
		},
		metadata: {
			cwd: "/work/other",
			gitBranch: "main",
			piVersion: "1.0.0",
			refreshedAtMs: 0,
		},
		createdAtMs: 0,
		lastOpenedAtMs: 0,
	},
};

async function run() {
	await initializeI18n("en-US");
	const currentProjectId = signal<"p1" | "p2">("p1");
	const scenario = signal<
		| "normal"
		| "status-error"
		| "diff-error"
		| "after-refresh"
		| "special-diffs"
		| "stale-race"
	>("normal");
	const statusCalls = signal(0);
	const diffCalls = signal<string[]>([]);
	const workspace = new WorkspaceStore();
	const toasts = new AppToasts();
	const project = computed(() => projects[currentProjectId()]);

	let pendingSlowResolve: ((text: string) => void) | null = null;
	let diffErrorAttempts = 0;

	const git: GitWorkspaceClient = {
		async getProjectGitStatus(projectId: string): Promise<GitStatus> {
			statusCalls.update((count) => count + 1);
			if (projectId === "p2") {
				return {
					branch: "main",
					files: [],
				};
			}
			const mode = scenario();
			if (mode === "status-error") {
				throw new Error("not a git repository");
			}
			if (mode === "after-refresh") {
				return {
					branch: "feat/git-panel",
					files: [
						{
							path: "notes.md",
							indexStatus: "?",
							worktreeStatus: "?",
							staged: false,
							unstaged: true,
							untracked: true,
						},
					],
				};
			}
			if (mode === "special-diffs") {
				return {
					branch: "feat/special",
					files: [
						{
							path: "assets/logo.png",
							indexStatus: " ",
							worktreeStatus: "M",
							staged: false,
							unstaged: true,
							untracked: false,
						},
						{
							path: "src/conflict.ts",
							indexStatus: "U",
							worktreeStatus: "U",
							staged: false,
							unstaged: true,
							untracked: false,
						},
						{
							path: "src/truncated.ts",
							indexStatus: " ",
							worktreeStatus: "M",
							staged: false,
							unstaged: true,
							untracked: false,
						},
						{
							path: "empty.txt",
							indexStatus: " ",
							worktreeStatus: "M",
							staged: false,
							unstaged: true,
							untracked: false,
						},
					],
				};
			}
			return {
				branch: "feat/git-panel",
				files: [
					{
						path: "src/app.ts",
						indexStatus: " ",
						worktreeStatus: "M",
						staged: false,
						unstaged: true,
						untracked: false,
					},
					{
						path: "notes.md",
						indexStatus: "?",
						worktreeStatus: "?",
						staged: false,
						unstaged: true,
						untracked: true,
					},
					{
						path: "src/staged.ts",
						indexStatus: "A",
						worktreeStatus: " ",
						staged: true,
						unstaged: false,
						untracked: false,
					},
				],
			};
		},
		async getProjectGitDiff(
			_projectId: string,
			options: { path?: string; staged: boolean },
		): Promise<string> {
			diffCalls.update((list) => [
				...list,
				`${options.staged ? "staged" : "working"}:${options.path ?? ""}`,
			]);
			const mode = scenario();
			if (mode === "diff-error" && options.path === "src/app.ts") {
				diffErrorAttempts += 1;
				if (diffErrorAttempts === 1) {
					throw new Error("git diff timed out");
				}
				return STANDARD_DIFF;
			}
			if (mode === "stale-race" && options.path === "src/app.ts") {
				return await new Promise<string>((resolve) => {
					pendingSlowResolve = resolve;
				});
			}
			if (options.staged && options.path === "src/staged.ts") {
				return STAGED_DIFF;
			}
			switch (options.path) {
				case "src/app.ts":
					return STANDARD_DIFF;
				case "notes.md":
					return UNTRACKED_DIFF;
				case "assets/logo.png":
					return BINARY_DIFF;
				case "src/conflict.ts":
					return COMBINED_DIFF;
				case "src/truncated.ts":
					return TRUNCATED_DIFF;
				case "empty.txt":
					return "";
				default:
					return "";
			}
		},
	};

	const openFileLink = async (
		_projectId: string,
		url: string,
		preview: boolean,
	): Promise<WorkspaceFile | null> => {
		if (!preview) return null;
		if (url.endsWith("/src/app.ts")) {
			return {
				path: "/work/demo/src/app.ts",
				content: "export function greet(name: string) {\n  return name;\n}\n",
			};
		}
		return null;
	};

	const fileContext = {
		project,
		workspace,
		openFileLink,
		toasts,
	};

	const shownGitProjectId = computed(() => {
		const id = project().id;
		return workspace.isGitActive(id) ? id : null;
	});
	const shownFile = computed(() =>
		shownGitProjectId() ? null : workspace.activeFile(project().id),
	);

	mount(() => (
		<AppToaster.Provider value={toasts}>
			<View class="flex-1 flex-col bg-background">
				<View class="h-11 shrink-0 flex-row items-center border-b border-border px-2">
					<SessionHeader
						title={() => "Demo Session"}
						sessionId={() => "s1"}
						sessionPath={() => "/sessions/s1.jsonl"}
						showTitle={() => true}
						temporary={() => false}
						git={{
							open: () => workspace.isGitOpen(project().id),
							active: () => shownGitProjectId() !== null,
							onSelect: () => workspace.openGit(project().id),
							onClose: () => workspace.closeGit(project().id),
						}}
						files={{
							tabs: () => workspace.files(project().id),
							activePath: () => shownFile()?.file.path ?? null,
							onSelect: (path) => workspace.selectFile(project().id, path),
							onClose: (path) => workspace.closeFile(project().id, path),
						}}
						onSelectChat={() => workspace.selectChat(project().id)}
						actions={
							<HeaderActions
								project={project}
								terminalRunning={() => false}
								terminalOpening={() => false}
								onNewTemporaryChat={() => {}}
								temporary={() => false}
								onOpenGit={() => workspace.openGit(project().id)}
								gitActive={() => shownGitProjectId() !== null}
								onError={(message) =>
									toasts.show({ variant: "error", title: message })
								}
							/>
						}
					/>
				</View>
				<View class="relative min-h-0 flex-1">
					<View
						testID="chat-underneath"
						class="flex-1 items-center justify-center"
					>
						<Text class="font-sans text-sm text-foreground">
							{() => `Chat in ${project().name}`}
						</Text>
					</View>
					<FilePreviewLayer
						workspace={workspace}
						active={shownFile}
						projectFor={(id) =>
							id === "p1" ? projects.p1 : id === "p2" ? projects.p2 : null
						}
						preferences={() => undefined}
					/>
					<GitWorkspaceLayer
						workspace={workspace}
						activeProjectId={shownGitProjectId}
						git={git}
						preferences={() => undefined}
						canOpenFile={(path) => canOpenToolFilePath(fileContext, path)}
						onOpenFile={(path) => openToolFilePath(fileContext, path)}
					/>
				</View>
				<View class="shrink-0 flex-row flex-wrap items-center gap-1 border-t border-border px-2 py-1">
					<Button
						testID="switch-project"
						size="sm"
						variant="ghost"
						onPress={() =>
							currentProjectId.set(currentProjectId() === "p1" ? "p2" : "p1")
						}
					>
						<Text class="font-sans text-xs">
							{() => `Project ${currentProjectId()}`}
						</Text>
					</Button>
					<Button
						testID="scenario-status-error"
						size="sm"
						variant="ghost"
						onPress={() => scenario.set("status-error")}
					>
						<Text class="font-sans text-xs">StatusError</Text>
					</Button>
					<Button
						testID="scenario-normal"
						size="sm"
						variant="ghost"
						onPress={() => scenario.set("normal")}
					>
						<Text class="font-sans text-xs">Normal</Text>
					</Button>
					<Button
						testID="scenario-diff-error"
						size="sm"
						variant="ghost"
						onPress={() => {
							diffErrorAttempts = 0;
							scenario.set("diff-error");
						}}
					>
						<Text class="font-sans text-xs">DiffError</Text>
					</Button>
					<Button
						testID="scenario-after-refresh"
						size="sm"
						variant="ghost"
						onPress={() => scenario.set("after-refresh")}
					>
						<Text class="font-sans text-xs">AfterRefresh</Text>
					</Button>
					<Button
						testID="scenario-special-diffs"
						size="sm"
						variant="ghost"
						onPress={() => scenario.set("special-diffs")}
					>
						<Text class="font-sans text-xs">SpecialDiffs</Text>
					</Button>
					<Button
						testID="scenario-stale-race"
						size="sm"
						variant="ghost"
						onPress={() => scenario.set("stale-race")}
					>
						<Text class="font-sans text-xs">StaleRace</Text>
					</Button>
					<Button
						testID="resolve-slow-diff"
						size="sm"
						variant="ghost"
						onPress={() => {
							pendingSlowResolve?.(
								[
									"diff --git a/src/app.ts b/src/app.ts",
									"--- a/src/app.ts",
									"+++ b/src/app.ts",
									"@@ -1,1 +1,1 @@",
									"-stale-old",
									"+STALE_PAYLOAD_SHOULD_NOT_SHOW",
								].join("\n"),
							);
							pendingSlowResolve = null;
						}}
					>
						<Text class="font-sans text-xs">ResolveSlow</Text>
					</Button>
					<Text testID="git-debug-status-calls" class="font-mono text-xs">
						{() => `statusCalls:${statusCalls()}`}
					</Text>
					<Text testID="git-debug-view-state" class="font-mono text-xs">
						{() => {
							const v = workspace.gitView(project().id);
							return `view:${v.mode}:${v.diffStyle}:${v.wrapLines ? "wrap" : "nowrap"}:${v.selectedPath ?? "none"}`;
						}}
					</Text>
				</View>
				<AppToastStack toasts={toasts} />
			</View>
		</AppToaster.Provider>
	));
}

await run();
