import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { FileCode, MessageSquare, Save, X } from "lucide-react";
import { toast } from "sonner";

import { readWorkspaceFile, writeWorkspaceFile } from "@/lib/files";
import "@/lib/monaco-setup";
import { cn } from "@/lib/utils";
import type { Workspace } from "@/lib/workspaces";
import { TRAFFIC_LIGHT_GUTTER } from "@/components/title-bar";
import { Button, EmptyState } from "@/ui";

export type EditorOpenRequest = {
	id: number;
	workspaceId: string;
	path: string;
};

type EditorTab = {
	path: string;
	content: string;
	savedContent: string;
	loading: boolean;
	error?: string;
};

const MAX_EDITOR_BYTES = 5 * 1024 * 1024;

function languageForPath(path: string) {
	const extension = path.split(".").pop()?.toLowerCase();
	switch (extension) {
		case "ts":
		case "mts":
		case "cts":
			return "typescript";
		case "tsx":
			return "typescript";
		case "js":
		case "mjs":
		case "cjs":
		case "jsx":
			return "javascript";
		case "json":
			return "json";
		case "css":
		case "scss":
		case "less":
			return extension;
		case "html":
		case "htm":
			return "html";
		case "md":
		case "mdx":
			return "markdown";
		case "rs":
			return "rust";
		case "py":
			return "python";
		case "go":
			return "go";
		case "sh":
		case "bash":
		case "zsh":
			return "shell";
		case "yml":
		case "yaml":
			return "yaml";
		case "xml":
			return "xml";
		default:
			return "plaintext";
	}
}

function decodeFile(data: Uint8Array) {
	if (data.byteLength > MAX_EDITOR_BYTES) {
		throw new Error(
			`文件超过 ${MAX_EDITOR_BYTES / 1024 / 1024} MB，暂不在编辑器中打开。`,
		);
	}
	if (data.subarray(0, Math.min(data.length, 8192)).includes(0)) {
		throw new Error("该文件看起来是二进制文件，无法作为文本编辑。 ");
	}
	return new TextDecoder("utf-8", { fatal: true }).decode(data);
}

function fileName(path: string) {
	return path.split("/").pop() || path;
}

export function WorkspaceEditor({
	workspace,
	request,
	visible,
	onClose,
	reserveTrafficLights = false,
}: {
	workspace: Workspace;
	request?: EditorOpenRequest;
	visible: boolean;
	onClose: () => void;
	/** macOS 侧边栏折叠时红绿灯覆盖主区左上角，顶部需要避让。 */
	reserveTrafficLights?: boolean;
}) {
	const [tabs, setTabs] = useState<EditorTab[]>([]);
	const [activePath, setActivePath] = useState<string | null>(null);
	const [savingPath, setSavingPath] = useState<string | null>(null);
	const openedPathsRef = useRef(new Set<string>());
	const activeTab = useMemo(
		() => tabs.find((tab) => tab.path === activePath) ?? null,
		[activePath, tabs],
	);

	useEffect(() => {
		if (!request || request.workspaceId !== workspace.id) return;
		const path = request.path;
		const timer = window.setTimeout(() => {
			const alreadyOpen = openedPathsRef.current.has(path);
			setActivePath(path);
			if (alreadyOpen) return;
			openedPathsRef.current.add(path);
			setTabs((current) => {
				return [
					...current,
					{ path, content: "", savedContent: "", loading: true },
				];
			});
			void readWorkspaceFile(workspace.id, path)
				.then((data) => decodeFile(data))
				.then((content) => {
					setTabs((current) =>
						current.map((tab) =>
							tab.path === path
								? {
										...tab,
										content,
										savedContent: content,
										loading: false,
										error: undefined,
									}
								: tab,
						),
					);
				})
				.catch((error) => {
					setTabs((current) =>
						current.map((tab) =>
							tab.path === path
								? {
										...tab,
										loading: false,
										error:
											error instanceof Error ? error.message : String(error),
									}
								: tab,
						),
					);
				});
		}, 0);
		return () => window.clearTimeout(timer);
	}, [request, workspace.id]);

	const saveTab = useCallback(
		async (path: string) => {
			const tab = tabs.find((candidate) => candidate.path === path);
			if (!tab || tab.loading || tab.error || tab.content === tab.savedContent)
				return;
			setSavingPath(path);
			try {
				await writeWorkspaceFile(
					workspace.id,
					path,
					new TextEncoder().encode(tab.content),
				);
				setTabs((current) =>
					current.map((candidate) =>
						candidate.path === path
							? { ...candidate, savedContent: candidate.content }
							: candidate,
					),
				);
				toast.success(`已保存 ${fileName(path)}`);
			} catch (error) {
				toast.error("保存文件失败", {
					description: error instanceof Error ? error.message : String(error),
				});
			} finally {
				setSavingPath(null);
			}
		},
		[tabs, workspace.id],
	);

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (
				!visible ||
				!activePath ||
				!(event.metaKey || event.ctrlKey) ||
				event.key !== "s"
			) {
				return;
			}
			event.preventDefault();
			void saveTab(activePath);
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [activePath, saveTab, visible]);

	const closeTab = useCallback(
		(path: string) => {
			const tab = tabs.find((candidate) => candidate.path === path);
			if (tab && tab.content !== tab.savedContent) {
				const close = window.confirm(
					`${fileName(path)} 有未保存修改，仍要关闭吗？`,
				);
				if (!close) return;
			}
			const index = tabs.findIndex((candidate) => candidate.path === path);
			const next = tabs.filter((candidate) => candidate.path !== path);
			openedPathsRef.current.delete(path);
			setTabs(next);
			if (activePath === path) {
				setActivePath(next[Math.min(index, next.length - 1)]?.path ?? null);
			}
		},
		[activePath, tabs],
	);

	return (
		<div
			className={cn(
				"absolute inset-0 z-20 flex min-h-0 flex-col bg-background",
				!visible && "hidden",
			)}
		>
			<header
				className={cn(
					"flex h-10 shrink-0 items-center border-b border-border bg-muted/20",
					reserveTrafficLights && TRAFFIC_LIGHT_GUTTER,
				)}
			>
				<Button
					variant="ghost"
					size="sm"
					className="ml-1 h-7 gap-1.5 px-2 text-xs text-muted-foreground"
					onClick={onClose}
				>
					<MessageSquare className="size-3.5" />
					聊天
				</Button>
				<div className="scrollbar-pro flex min-w-0 flex-1 items-stretch overflow-x-auto px-1">
					{tabs.map((tab) => {
						const dirty = tab.content !== tab.savedContent;
						return (
							<div
								key={tab.path}
								className={cn(
									"group/tab flex max-w-56 shrink-0 items-center border-x border-transparent text-xs text-muted-foreground",
									activePath === tab.path &&
										"border-border bg-background text-foreground",
								)}
							>
								<button
									type="button"
									className="flex min-w-0 items-center gap-1.5 px-2.5 py-2"
									onClick={() => setActivePath(tab.path)}
								>
									<FileCode className="size-3.5 shrink-0" />
									<span className="truncate">{fileName(tab.path)}</span>
									{dirty ? (
										<span className="size-1.5 shrink-0 rounded-full bg-current" />
									) : null}
								</button>
								<button
									type="button"
									className="mr-1 rounded p-0.5 opacity-0 hover:bg-muted group-hover/tab:opacity-100 focus-visible:opacity-100"
									aria-label={`关闭 ${fileName(tab.path)}`}
									onClick={() => closeTab(tab.path)}
								>
									<X className="size-3" />
								</button>
							</div>
						);
					})}
				</div>
				{activeTab && !activeTab.loading && !activeTab.error ? (
					<Button
						variant="ghost"
						size="sm"
						className="mr-1 h-7 gap-1.5 px-2 text-xs"
						disabled={
							activeTab.content === activeTab.savedContent ||
							savingPath === activeTab.path
						}
						onClick={() => void saveTab(activeTab.path)}
					>
						<Save className="size-3.5" />
						保存
					</Button>
				) : null}
			</header>
			<div className="min-h-0 flex-1">
				{!activeTab ? (
					<EmptyState
						title="打开文件开始编辑"
						description="可从右侧文件树或 Git 变更中打开文件。"
					/>
				) : activeTab.loading ? (
					<div className="flex h-full items-center justify-center text-xs text-muted-foreground">
						正在读取 {activeTab.path}…
					</div>
				) : activeTab.error ? (
					<EmptyState title="无法打开文件" description={activeTab.error} />
				) : (
					<Editor
						path={`${workspace.id}:${activeTab.path}`}
						language={languageForPath(activeTab.path)}
						value={activeTab.content}
						onChange={(value) => {
							setTabs((current) =>
								current.map((tab) =>
									tab.path === activeTab.path
										? { ...tab, content: value ?? "" }
										: tab,
								),
							);
						}}
						options={{
							automaticLayout: true,
							fontFamily: '"JetBrains Mono", ui-monospace, monospace',
							fontSize: 12,
							minimap: { enabled: false },
							scrollBeyondLastLine: false,
							padding: { top: 10 },
						}}
					/>
				)}
			</div>
		</div>
	);
}
