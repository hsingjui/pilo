import {
	useCallback,
	useEffect,
	useMemo,
	useState,
	type RefObject,
} from "react";
import { Panel, type PanelImperativeHandle } from "react-resizable-panels";
import { FileCode, GitBranch, PanelRight, RefreshCw } from "lucide-react";

import { FileExplorer } from "@/components/file-explorer";
import { ParallelAgentsPanel } from "@/components/parallel-agents-panel";
import { PreviewPanel } from "@/components/preview-panel";
import { CUSTOM_TITLEBAR } from "@/components/title-bar";
import {
	getProjectGitDiff,
	getProjectGitStatus,
	type GitFileStatus,
	type GitStatus,
} from "@/lib/git";
import { cn } from "@/lib/utils";
import type { Project } from "@/lib/projects";
import { Button, EmptyState, ErrorState, Separator } from "@/ui";

type DiffMode = "working" | "staged";
type SidebarView = "changes" | "files" | "agents" | "preview";

type LoadState = "idle" | "loading" | "ready" | "error";

function fileStatusLabel(file: GitFileStatus, mode: DiffMode) {
	if (file.untracked) return "?";
	const status = mode === "staged" ? file.indexStatus : file.worktreeStatus;
	return status.trim() || (file.staged ? file.indexStatus.trim() : "M") || "M";
}

function DiffViewer({ diff }: { diff: string }) {
	if (!diff) {
		return (
			<EmptyState
				variant="compact"
				title="没有可显示的 diff"
				description="该文件在当前视图下没有文本差异。"
			/>
		);
	}

	const lines = Array.from(diff.matchAll(/[^\n]*(?:\n|$)/g))
		.filter((match) => match[0] !== "")
		.map((match) => {
			const line = match[0].endsWith("\n") ? match[0].slice(0, -1) : match[0];
			return { key: `${match.index}:${line.slice(0, 24)}`, line };
		});

	return (
		<pre className="scrollbar-pro min-h-0 flex-1 overflow-auto whitespace-pre font-mono text-[11px] leading-[1.55]">
			{lines.map(({ key, line }) => (
				<span
					key={key}
					className={cn(
						"block min-w-max px-3",
						line.startsWith("+") && !line.startsWith("+++") && "bg-primary/10",
						line.startsWith("-") &&
							!line.startsWith("---") &&
							"bg-destructive/10",
						line.startsWith("@@") && "bg-muted/70 text-muted-foreground",
					)}
				>
					{line || " "}
				</span>
			))}
		</pre>
	);
}

export function RightSidebar({
	panelRef,
	resizing,
	project,
	onOpenFile,
}: {
	panelRef: RefObject<PanelImperativeHandle | null>;
	resizing: boolean;
	project?: Project;
	onOpenFile?: (path: string) => void;
}) {
	const [view, setView] = useState<SidebarView>("changes");
	const [status, setStatus] = useState<GitStatus | null>(null);
	const [loadState, setLoadState] = useState<LoadState>("idle");
	const [error, setError] = useState<string | null>(null);
	const [mode, setMode] = useState<DiffMode>("working");
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [diff, setDiff] = useState("");
	const [diffLoading, setDiffLoading] = useState(false);

	const visibleFiles = useMemo(() => {
		const files = status?.files ?? [];
		return files.filter((file) =>
			mode === "staged" ? file.staged : file.unstaged,
		);
	}, [mode, status]);
	const effectiveSelectedPath = visibleFiles.some(
		(file) => file.path === selectedPath,
	)
		? selectedPath
		: (visibleFiles[0]?.path ?? null);

	const refresh = useCallback(async () => {
		if (!project) {
			setStatus(null);
			setSelectedPath(null);
			setLoadState("idle");
			return;
		}
		setLoadState("loading");
		setError(null);
		try {
			const next = await getProjectGitStatus(project.id);
			setStatus(next);
			setLoadState("ready");
		} catch (loadError) {
			setStatus(null);
			setLoadState("error");
			setError(
				loadError instanceof Error ? loadError.message : String(loadError),
			);
		}
	}, [project]);

	useEffect(() => {
		const timer = window.setTimeout(() => void refresh(), 0);
		return () => window.clearTimeout(timer);
	}, [refresh]);

	useEffect(() => {
		if (!project || !effectiveSelectedPath) return;
		let cancelled = false;
		const timer = window.setTimeout(() => {
			if (cancelled) return;
			setDiffLoading(true);
			void getProjectGitDiff(project.id, {
				path: effectiveSelectedPath,
				staged: mode === "staged",
			})
				.then((value) => {
					if (!cancelled) setDiff(value);
				})
				.catch((loadError) => {
					if (!cancelled) {
						setDiff(
							`无法读取 diff：${loadError instanceof Error ? loadError.message : String(loadError)}`,
						);
					}
				})
				.finally(() => {
					if (!cancelled) setDiffLoading(false);
				});
		}, 0);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [effectiveSelectedPath, mode, project]);

	return (
		<Panel
			panelRef={panelRef}
			defaultSize={0}
			minSize={280}
			collapsible
			collapsedSize={0}
			className={cn(
				"min-w-0",
				!resizing && "transition-[flex-grow] duration-200 ease-out",
			)}
		>
			<aside className="flex h-full min-w-0 flex-col border-l border-sidebar-border bg-sidebar text-sidebar-foreground">
				<header
					data-tauri-drag-region="deep"
					className={cn(
						"flex h-10 shrink-0 items-center gap-2 px-3",
						CUSTOM_TITLEBAR && "pr-[7.75rem]",
					)}
				>
					<div className="flex items-center gap-0.5">
						{(["changes", "files", "agents", "preview"] as const).map(
							(value) => (
								<button
									key={value}
									type="button"
									className={cn(
										"rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
										view === value && "bg-muted text-foreground",
									)}
									onClick={() => setView(value)}
								>
									{value === "changes"
										? "变更"
										: value === "files"
											? "文件"
											: value === "agents"
												? "Agents"
												: "Preview"}
								</button>
							),
						)}
					</div>
					{view === "changes" && status?.branch ? (
						<span className="flex min-w-0 items-center gap-1 truncate text-[11px] text-sidebar-foreground-muted">
							<GitBranch className="size-3" />
							<span className="truncate">{status.branch}</span>
						</span>
					) : null}
					{view === "changes" ? (
						<Button
							variant="ghost"
							size="icon"
							className="ms-auto size-7"
							aria-label="刷新 Git 状态"
							onClick={() => void refresh()}
							disabled={!project || loadState === "loading"}
						>
							<RefreshCw
								className={cn(
									"size-3.5",
									loadState === "loading" && "animate-spin",
								)}
							/>
						</Button>
					) : (
						<span className="ms-auto" />
					)}
					<Button
						variant="ghost"
						size="icon"
						className="size-7"
						aria-label="收起右侧栏"
						onClick={() => panelRef.current?.collapse()}
					>
						<PanelRight className="size-4" />
					</Button>
				</header>
				<Separator className="bg-sidebar-border" />
				{view === "agents" ? (
					project ? (
						<ParallelAgentsPanel key={project.id} project={project} />
					) : (
						<EmptyState
							variant="compact"
							title="未选择项目"
							description="选择项目后可创建并行 Agent。"
						/>
					)
				) : view === "preview" ? (
					project ? (
						<PreviewPanel key={project.id} project={project} />
					) : (
						<EmptyState
							variant="compact"
							title="未选择项目"
							description="选择项目后可打开 Preview。"
						/>
					)
				) : view === "files" ? (
					project ? (
						<FileExplorer
							key={project.id}
							project={project}
							onOpenFile={(path) => onOpenFile?.(path)}
						/>
					) : (
						<EmptyState
							variant="compact"
							title="未选择项目"
							description="选择项目后可浏览文件。"
						/>
					)
				) : !project ? (
					<EmptyState
						variant="compact"
						title="未选择项目"
						description="选择项目后可查看 Git 变更。"
					/>
				) : loadState === "error" ? (
					<ErrorState
						variant="compact"
						title="无法读取 Git 状态"
						description={error ?? "请检查当前项目是否为 Git 仓库。"}
						onRetry={() => void refresh()}
					/>
				) : (
					<>
						<div className="flex shrink-0 items-center gap-1 p-2">
							{(["working", "staged"] as const).map((value) => (
								<button
									key={value}
									type="button"
									className={cn(
										"rounded-md px-2 py-1 text-xs text-muted-foreground",
										mode === value && "bg-muted text-foreground",
									)}
									onClick={() => setMode(value)}
								>
									{value === "working" ? "工作区" : "暂存"}
								</button>
							))}
							<span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
								{visibleFiles.length} files
							</span>
						</div>
						<Separator className="bg-sidebar-border" />
						<div className="max-h-[38%] shrink-0 overflow-y-auto p-1.5">
							{loadState === "loading" && !status ? (
								<div className="px-2 py-4 text-center text-xs text-muted-foreground">
									正在读取 Git 状态…
								</div>
							) : visibleFiles.length === 0 ? (
								<EmptyState
									variant="compact"
									title="暂无变更"
									description={
										mode === "working"
											? "工作区没有未暂存变更。"
											: "暂存区没有变更。"
									}
								/>
							) : (
								<ul className="grid gap-0.5">
									{visibleFiles.map((file) => (
										<li key={file.path}>
											<button
												type="button"
												className={cn(
													"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60",
													effectiveSelectedPath === file.path &&
														"bg-muted text-foreground",
												)}
												onClick={() => setSelectedPath(file.path)}
												onDoubleClick={() => onOpenFile?.(file.path)}
												title={onOpenFile ? "双击在编辑器中打开" : undefined}
											>
												<FileCode className="size-3.5 shrink-0 text-sidebar-foreground-muted" />
												<span className="min-w-0 flex-1 truncate">
													{file.path}
												</span>
												<span className="w-4 shrink-0 text-center font-mono text-[11px] text-muted-foreground">
													{fileStatusLabel(file, mode)}
												</span>
											</button>
										</li>
									))}
								</ul>
							)}
						</div>
						<Separator className="bg-sidebar-border" />
						<div className="flex min-h-0 flex-1 flex-col bg-background/40">
							{effectiveSelectedPath ? (
								<button
									type="button"
									className="shrink-0 truncate border-b border-sidebar-border px-3 py-2 text-left font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
									onClick={() => onOpenFile?.(effectiveSelectedPath)}
									disabled={!onOpenFile}
									title={onOpenFile ? "在编辑器中打开" : undefined}
								>
									{effectiveSelectedPath}
								</button>
							) : null}
							{diffLoading ? (
								<div className="px-3 py-4 text-xs text-muted-foreground">
									正在读取 diff…
								</div>
							) : (
								<DiffViewer diff={diff} />
							)}
						</div>
					</>
				)}
			</aside>
		</Panel>
	);
}
