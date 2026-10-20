import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { Group, Panel, useGroupRef, type Layout } from "react-resizable-panels";
import {
	ArrowLeft,
	CheckCheck,
	Columns2,
	FileCode,
	GitBranch,
	RefreshCw,
	Rows2,
	WrapText,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { useChatFileOpen } from "@/components/chat/chat-file-open-context";
import { DiffViewer } from "@/components/git-diff-viewer";
import {
	GitDiffSkeleton,
	GitWorkspaceSkeleton,
} from "@/components/git-workspace-skeleton";
import {
	getProjectGitDiff,
	getProjectGitStatus,
	type GitFileStatus,
	type GitStatus,
} from "@/lib/api/git";
import { toAppError } from "@/lib/app-error";
import type { GitWorkspaceView } from "@/lib/project-workspace";
import { cn } from "@/lib/utils";
import {
	RESIZE_TARGET_MINIMUM_SIZE,
	ResizeSeparator,
} from "@/ui/resize-separator";
import { Button, EmptyState, ErrorState, Hint } from "@/ui";

type DiffMode = GitWorkspaceView["mode"];
type DiffResult = {
	retry: number;
	path: string;
	mode: DiffMode;
	status: GitStatus;
	text: string;
	error?: string;
};

function FileStatusBadge({
	file,
	mode,
}: {
	file: GitFileStatus;
	mode: DiffMode;
}) {
	const { t } = useTranslation();
	const code = file.untracked
		? "?"
		: (mode === "staged" ? file.indexStatus : file.worktreeStatus).trim() ||
			"M";
	const labels: Record<string, string> = {
		"?": t("file.statusUntracked"),
		A: t("file.statusAdded"),
		D: t("file.statusDeleted"),
		M: t("file.statusModified"),
		R: t("file.statusRenamed"),
		C: t("file.statusCopied"),
		U: t("file.statusUnmerged"),
	};
	return (
		<span
			title={labels[code] ?? code}
			className={cn(
				"flex size-5 shrink-0 items-center justify-center rounded-sm font-mono text-[11px] font-semibold",
				code === "?" || code === "A"
					? "bg-status-success/10 text-status-success"
					: code === "D" || code === "U"
						? "bg-status-danger/10 text-status-danger"
						: "bg-status-warning/10 text-status-warning",
			)}
		>
			<span aria-hidden="true">{code}</span>
			<span className="sr-only">{labels[code] ?? code}</span>
		</span>
	);
}

/** Desktop-only content, loaded by the shared workspace after the native gate. */
export function GitWorkspace({
	projectId,
	active,
	view,
	onViewChange,
}: {
	projectId: string;
	active: boolean;
	view: GitWorkspaceView;
	onViewChange: (view: Partial<GitWorkspaceView>) => void;
}) {
	const { t } = useTranslation();
	const { mode, selectedPath, showDetail, listWidth, diffStyle, wrapLines } =
		view;
	const fileOpener = useChatFileOpen();
	const [snapshot, setSnapshot] = useState<{
		revision: number;
		status: GitStatus;
	} | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [revision, setRevision] = useState(0);
	const [diffRetry, setDiffRetry] = useState(0);
	const [diff, setDiff] = useState<DiffResult | null>(null);
	const backRef = useRef<HTMLButtonElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const listPanelId = useId();
	const diffPanelId = useId();
	// Panel IDs change on remount; retain the proportion, not the old ID-keyed layout.
	const panelLayout = useMemo<Layout | undefined>(
		() =>
			listWidth === undefined
				? undefined
				: { [listPanelId]: listWidth, [diffPanelId]: 100 - listWidth },
		[listWidth, listPanelId, diffPanelId],
	);
	const groupRef = useGroupRef();
	const [wide, setWide] = useState(false);
	const [canSplit, setCanSplit] = useState(false);
	const effectiveDiffStyle = canSplit ? diffStyle : "unified";

	useEffect(() => {
		if (wide && panelLayout) groupRef.current?.setLayout(panelLayout);
	}, [groupRef, panelLayout, wide]);

	const measureWorkspace = useCallback((pane: HTMLDivElement | null) => {
		if (!pane) return;
		const observer = new ResizeObserver(([entry]) => {
			if (!entry) return;
			const rem = Number.parseFloat(
				getComputedStyle(document.documentElement).fontSize,
			);
			setWide(entry.contentRect.width >= 40 * rem);
		});
		observer.observe(pane);
		return () => observer.disconnect();
	}, []);

	const measureDiffPane = useCallback((pane: HTMLDivElement | null) => {
		if (!pane) return;
		const observer = new ResizeObserver(([entry]) => {
			if (entry) setCanSplit(entry.contentRect.width >= 600);
		});
		observer.observe(pane);
		return () => observer.disconnect();
	}, []);

	const status = snapshot?.revision === revision ? snapshot.status : null;
	const visibleFiles = useMemo(
		() =>
			(status?.files ?? []).filter((file) =>
				mode === "staged" ? file.staged : file.unstaged,
			),
		[status, mode],
	);
	const path = visibleFiles.some((file) => file.path === selectedPath)
		? selectedPath
		: (visibleFiles[0]?.path ?? null);
	const currentDiff =
		diff?.path === path &&
		diff.mode === mode &&
		diff.status === status &&
		diff.retry === diffRetry
			? diff
			: null;

	useEffect(() => {
		if (!active) return;
		let cancelled = false;
		const timer = window.setTimeout(() => {
			setLoading(true);
			setError(null);
			void getProjectGitStatus(projectId)
				.then((next) => {
					if (cancelled) return;
					setSnapshot({ revision, status: next });
					setLoading(false);
				})
				.catch((cause: unknown) => {
					if (cancelled) return;
					setSnapshot(null);
					setError(toAppError(cause).detail ?? t("file.gitRepoHint"));
					setLoading(false);
				});
		}, 0);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [projectId, active, revision, t]);

	useEffect(() => {
		if (!active || !status || !path || loading) return;
		let cancelled = false;
		const timer = window.setTimeout(() => {
			void getProjectGitDiff(projectId, { path, staged: mode === "staged" })
				.then((text) => {
					if (!cancelled)
						setDiff({ path, mode, status, text, retry: diffRetry });
				})
				.catch((cause: unknown) => {
					if (!cancelled)
						setDiff({
							retry: diffRetry,
							path,
							mode,
							status,
							text: "",
							error: toAppError(cause).detail ?? t("common.loadFailed"),
						});
				});
		}, 0);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [projectId, active, status, path, mode, loading, diffRetry, t]);

	const refresh = () => {
		setError(null);
		setLoading(true);
		setRevision((value) => value + 1);
	};
	const selectedFile = visibleFiles.find((file) => file.path === path);
	const filename = path?.split("/").at(-1);
	return (
		<div
			ref={measureWorkspace}
			className="@container/git flex min-h-0 min-w-0 flex-1 flex-col pb-[env(safe-area-inset-bottom)]"
		>
			<div className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4">
				<h2 className="text-sm font-medium">{t("file.changes")}</h2>
				<span
					aria-label={t("file.fileCount", {
						count: snapshot?.status.files.length ?? 0,
					})}
					className="rounded-md bg-muted px-1.5 py-0.5 text-2xs tabular-nums text-muted-foreground"
				>
					{snapshot?.status.files.length ?? 0}
				</span>
				<div className="ml-auto flex min-w-0 items-center gap-1">
					<span
						className="mr-1 flex min-w-0 items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1 text-xs text-muted-foreground"
						title={snapshot?.status.branch ?? undefined}
					>
						<GitBranch aria-hidden="true" className="size-3.5 shrink-0" />
						<span className="max-w-48 truncate">
							{snapshot?.status.branch || "Git"}
						</span>
					</span>
					<Hint label={t("file.gitRefresh")}>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="size-8 text-muted-foreground [@media(pointer:coarse)]:size-11"
							aria-label={t("file.gitRefresh")}
							disabled={loading}
							onClick={refresh}
						>
							<RefreshCw
								aria-hidden="true"
								className={cn(
									"size-3.5",
									loading && "animate-spin motion-reduce:animate-none",
								)}
							/>
						</Button>
					</Hint>
				</div>
			</div>
			{error ? (
				<div className="scrollbar-pro flex min-h-0 flex-1 items-center overflow-auto">
					<ErrorState
						title={t("file.gitReadFailed")}
						description={error}
						onRetry={refresh}
					/>
				</div>
			) : loading && !status ? (
				<GitWorkspaceSkeleton
					header={false}
					diffStyle={effectiveDiffStyle}
					listWidth={listWidth}
				/>
			) : (
				<Group
					orientation="horizontal"
					groupRef={groupRef}
					disabled={!wide}
					defaultLayout={panelLayout}
					onLayoutChanged={(next, { isUserInteraction }) => {
						if (wide && (isUserInteraction || listWidth === undefined))
							onViewChange({ listWidth: next[listPanelId] });
					}}
					resizeTargetMinimumSize={RESIZE_TARGET_MINIMUM_SIZE}
					className="min-h-0 min-w-0 flex-1"
				>
					<Panel
						id={listPanelId}
						defaultSize="16rem"
						minSize={wide ? "12rem" : 0}
						maxSize={wide ? "50%" : "100%"}
						hidden={!wide && Boolean(showDetail && path)}
						className="flex min-h-0 min-w-0 flex-col"
						style={{ overflow: "hidden" }}
					>
						<div
							ref={listRef}
							className="flex min-h-0 min-w-0 flex-1 flex-col bg-muted/15"
						>
							<div className="flex min-h-10 shrink-0 items-center px-3 py-0.5">
								<fieldset className="flex min-w-0 w-full gap-0.5 rounded-lg bg-muted/70 p-0.5">
									<legend className="sr-only">{t("file.changes")}</legend>
									{(["working", "staged"] as const).map((value) => (
										<Button
											key={value}
											type="button"
											variant="ghost"
											size="sm"
											aria-pressed={mode === value}
											className={cn(
												"min-w-0 flex-1 gap-2 rounded-md text-xs [@media(pointer:coarse)]:min-h-11",
												mode === value
													? "bg-background text-foreground shadow-sm hover:bg-background"
													: "text-muted-foreground",
											)}
											onClick={() => {
												onViewChange({ mode: value, showDetail: false });
											}}
										>
											{value === "working"
												? t("file.workingTree")
												: t("file.staged")}
											<span className="text-2xs tabular-nums text-muted-foreground">
												{status?.files.filter((file) =>
													value === "staged" ? file.staged : file.unstaged,
												).length ?? 0}
											</span>
										</Button>
									))}
								</fieldset>
							</div>
							<div className="scrollbar-pro min-h-0 flex-1 overflow-auto overscroll-contain px-2 pb-2">
								{visibleFiles.length === 0 ? (
									<EmptyState
										variant="compact"
										icon={
											<CheckCheck
												aria-hidden="true"
												className="size-4 text-status-success"
											/>
										}
										title={t("file.noChanges")}
										description={
											mode === "working"
												? t("file.workingClean")
												: t("file.stagedClean")
										}
									/>
								) : (
									<ul className="grid gap-0.5">
										{visibleFiles.map((file) => {
											const split = file.path.lastIndexOf("/");
											return (
												<li key={file.path}>
													<button
														type="button"
														aria-pressed={path === file.path}
														title={
															file.originalPath
																? `${file.originalPath} → ${file.path}`
																: file.path
														}
														className={cn(
															"relative flex min-h-8 w-full items-center gap-2.5 rounded-md px-3 py-1.5 text-left hover:bg-hover/70 focus-visible:outline-2 focus-visible:outline-ring [@media(pointer:coarse)]:min-h-11",
															path === file.path
																? "bg-muted text-foreground"
																: "text-muted-foreground",
														)}
														onClick={() => {
															onViewChange({
																selectedPath: file.path,
																showDetail: true,
															});
															requestAnimationFrame(() => {
																if (backRef.current?.getClientRects().length)
																	backRef.current.focus();
															});
														}}
													>
														<FileCode
															aria-hidden="true"
															className="size-4 shrink-0 text-muted-foreground/80"
														/>
														<span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
															{file.path.slice(split + 1)}
														</span>
														<FileStatusBadge file={file} mode={mode} />
													</button>
												</li>
											);
										})}
									</ul>
								)}
							</div>
						</div>
					</Panel>
					<ResizeSeparator
						className="bg-border/60"
						hidden={!wide}
						disabled={!wide}
						aria-label={t("file.resizePanels")}
					/>
					<Panel
						id={diffPanelId}
						minSize={wide ? "20rem" : 0}
						hidden={!wide && !(showDetail && path)}
						className="flex min-h-0 min-w-0 flex-col"
						style={{ overflow: "hidden" }}
					>
						<div
							ref={measureDiffPane}
							className="flex min-h-0 min-w-0 flex-1 flex-col"
						>
							<div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
								<Button
									ref={backRef}
									type="button"
									variant="ghost"
									size="icon"
									aria-label={t("common.back")}
									className="size-8 shrink-0 text-muted-foreground @min-[40rem]/git:hidden [@media(pointer:coarse)]:size-11"
									onClick={() => {
										onViewChange({ showDetail: false });
										requestAnimationFrame(() =>
											listRef.current
												?.querySelector<HTMLButtonElement>(
													'button[aria-pressed="true"][title]',
												)
												?.focus(),
										);
									}}
								>
									<ArrowLeft aria-hidden="true" className="size-4" />
								</Button>
								{selectedFile ? (
									<FileStatusBadge file={selectedFile} mode={mode} />
								) : (
									<FileCode
										aria-hidden="true"
										className="size-4 shrink-0 text-muted-foreground"
									/>
								)}
								<span className="min-w-0 max-w-[40%] truncate text-sm font-medium">
									{filename ?? t("file.changes")}
								</span>
								<div className="flex min-w-0 flex-1">
									{path ? (
										<button
											type="button"
											className="min-h-8 min-w-0 truncate rounded-sm text-left text-2xs text-muted-foreground enabled:hover:underline focus-visible:outline-2 focus-visible:outline-ring [@media(pointer:coarse)]:min-h-11"
											disabled={!fileOpener?.canOpenFile(path)}
											onClick={() => fileOpener?.openFile(path)}
										>
											{path}
										</button>
									) : null}
								</div>
								<fieldset className="flex min-w-0 shrink-0 items-center gap-0.5 rounded-md bg-muted/50 p-0.5">
									<legend className="sr-only">{t("file.diffLayout")}</legend>
									{(["unified", "split"] as const).map((layout) => {
										const Icon = layout === "split" ? Columns2 : Rows2;
										const label = t(
											layout === "split"
												? "file.splitDiff"
												: "file.unifiedDiff",
										);
										return (
											<Hint key={layout} label={label}>
												<Button
													type="button"
													variant="ghost"
													size="icon"
													aria-label={label}
													aria-pressed={effectiveDiffStyle === layout}
													disabled={!path || (layout === "split" && !canSplit)}
													className={cn(
														"size-7 text-muted-foreground [@media(pointer:coarse)]:size-11",
														effectiveDiffStyle === layout &&
															"bg-background text-foreground shadow-sm hover:bg-background",
													)}
													onClick={() => onViewChange({ diffStyle: layout })}
												>
													<Icon aria-hidden="true" className="size-3.5" />
												</Button>
											</Hint>
										);
									})}
								</fieldset>
								<Hint label={t("file.wrapLines")}>
									<Button
										type="button"
										variant="ghost"
										size="icon"
										aria-label={t("file.wrapLines")}
										aria-pressed={wrapLines}
										disabled={!path}
										className={cn(
											"size-8 shrink-0 text-muted-foreground [@media(pointer:coarse)]:size-11",
											wrapLines && "bg-muted text-foreground",
										)}
										onClick={() => onViewChange({ wrapLines: !wrapLines })}
									>
										<WrapText aria-hidden="true" className="size-3.5" />
									</Button>
								</Hint>
							</div>
							{!path ? (
								<EmptyState
									className="flex-1"
									icon={
										<CheckCheck
											aria-hidden="true"
											className="size-4 text-status-success"
										/>
									}
									title={t("file.noChanges")}
									description={
										mode === "working"
											? t("file.workingClean")
											: t("file.stagedClean")
									}
								/>
							) : loading || !currentDiff ? (
								<GitDiffSkeleton diffStyle={effectiveDiffStyle} />
							) : currentDiff.error ? (
								<div className="scrollbar-pro flex min-h-0 flex-1 items-center overflow-auto">
									<ErrorState
										title={t("file.diffReadFailed")}
										description={currentDiff.error}
										onRetry={() => {
											setDiff(null);
											setDiffRetry((value) => value + 1);
										}}
									/>
								</div>
							) : (
								<DiffViewer
									key={`${mode}:${path}`}
									diff={currentDiff.text}
									diffStyle={effectiveDiffStyle}
									wrapLines={wrapLines}
								/>
							)}
						</div>
					</Panel>
				</Group>
			)}
		</div>
	);
}
