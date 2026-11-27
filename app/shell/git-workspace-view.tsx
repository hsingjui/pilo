import {
	cleanup,
	computed,
	effect,
	List,
	Scroll,
	signal,
	Text,
	token,
	untracked,
	View,
} from "nsh";
import {
	Button as BaseButton,
	ResizablePanel,
	ResizablePanelGroup,
} from "nsh/base";

import { fileBasename } from "@shared/chat/chat-tool-result";
import type { HostPreferenceValues } from "@shared/host-preferences-types";
import type { GitWorkspaceView } from "@shared/project-workspace";

import type { GitFileStatus, GitStatus } from "../client/nsh-pilo-client";
import type { WorkspaceStore } from "../state/workspace-store";
import { Button } from "../ui/button";
import { classNames } from "../ui/class-names";
import { blurOnPointerPress, focusRingStyle } from "../ui/focus-ring-style";
import { Icon } from "../ui/icon";
import { tactileTransition, useEnterFade } from "../ui/motion";
import { scrollbarLook, scrollbarTheme } from "../ui/scrollbar";
import { Skeleton } from "../ui/skeleton";
import { EmptyState, ErrorState } from "../ui/state-view";
import { Tab } from "../ui/tab";
import { Tabs } from "../ui/tabs";
import { styleVar } from "../ui/theme-style";
import { Tooltip } from "../ui/tooltip";
import { GitDiffViewer } from "./git-diff-viewer";
import { t } from "./i18n";

/** Native Git reads used by the desktop-only Git workspace tab. */
export interface GitWorkspaceClient {
	getProjectGitStatus: (projectId: string) => Promise<GitStatus>;
	getProjectGitDiff: (
		projectId: string,
		options: { path?: string; staged: boolean },
	) => Promise<string>;
}

function gitErrorDetail(cause: unknown, fallback: string) {
	const detail =
		typeof cause === "string"
			? cause
			: cause instanceof Error
				? cause.message
				: "";
	const text = detail.trim();
	if (/not a git repository/i.test(text)) return t("file.gitRepoHint");
	return text || fallback;
}

type DiffMode = GitWorkspaceView["mode"];
type LineChanges = { additions: number; deletions: number };

type DiffResult = {
	retry: number;
	path: string;
	mode: DiffMode;
	status: GitStatus;
	text: string;
	error?: string;
};

/** 40rem breakpoint matching the WebUI `@min-[40rem]/git` layout split. */
const WIDE_BREAKPOINT = 640;
/** Minimum diff pane width where side-by-side split view is enabled. */
const SPLIT_MIN_WIDTH = 600;
/** Default, minimum and diff minimum widths matching the WebUI's 16rem / 12rem / 20rem. */
const DEFAULT_LIST_WIDTH = 256;
const MIN_LIST_WIDTH = 192;
const MIN_DIFF_WIDTH = 320;

const SKELETON_LINE_WIDTHS = [
	68, 82, 47, 91, 59, 75, 38, 86, 54, 71, 94, 63,
] as const;
const SKELETON_FILE_WIDTHS = [66, 43, 79, 57, 71, 49, 85, 60] as const;

function lineChanges(file: GitFileStatus, mode: DiffMode): LineChanges | null {
	const additions =
		mode === "staged" ? file.stagedAdditions : file.unstagedAdditions;
	const deletions =
		mode === "staged" ? file.stagedDeletions : file.unstagedDeletions;
	return additions == null || deletions == null
		? null
		: { additions, deletions };
}

function LineChangeCounts(props: LineChanges) {
	return (
		<View class="shrink-0 flex-row items-center gap-1">
			<Text class="font-sans text-[11px] tabular-nums text-status-success">
				{() => `+${props.additions}`}
			</Text>
			<Text class="font-sans text-[11px] tabular-nums text-status-danger">
				{() => `−${props.deletions}`}
			</Text>
		</View>
	);
}

function statusCode(file: GitFileStatus, mode: DiffMode): string {
	return file.untracked
		? "?"
		: (mode === "staged" ? file.indexStatus : file.worktreeStatus).trim() ||
				"M";
}

function statusLabel(code: string): string {
	switch (code) {
		case "?":
			return t("file.statusUntracked");
		case "A":
			return t("file.statusAdded");
		case "D":
			return t("file.statusDeleted");
		case "M":
			return t("file.statusModified");
		case "R":
			return t("file.statusRenamed");
		case "C":
			return t("file.statusCopied");
		case "U":
			return t("file.statusUnmerged");
		default:
			return code;
	}
}

function FileStatusBadge(props: {
	file: () => GitFileStatus;
	mode: () => DiffMode;
}) {
	const code = computed(() => statusCode(props.file(), props.mode()));
	const label = computed(() => statusLabel(code()));
	const tone = computed(() => {
		const value = code();
		if (value === "?" || value === "A") {
			return {
				box: "bg-status-success/10",
				text: "text-status-success",
			};
		}
		if (value === "D" || value === "U") {
			return {
				box: "bg-status-danger/10",
				text: "text-status-danger",
			};
		}
		return {
			box: "bg-status-warning/10",
			text: "text-status-warning",
		};
	});
	return (
		<View
			accessible
			accessibilityLabel={label()}
			tooltip={
				<Tooltip>
					<Text class="font-sans">{label}</Text>
				</Tooltip>
			}
			class={classNames(
				"size-5 shrink-0 items-center justify-center rounded-(--pilo-radius-sm)",
				tone().box,
			)}
		>
			<Text
				class={classNames("font-mono text-[11px] font-semibold", tone().text)}
			>
				{code}
			</Text>
		</View>
	);
}

function GitDiffSkeleton(props: { diffStyle: () => "unified" | "split" }) {
	return (
		<View
			testID="git-diff-skeleton"
			role="progressbar"
			accessible
			accessibilityLabel={t("file.readingDiff")}
			class="min-h-0 min-w-0 flex-1 flex-row overflow-hidden"
		>
			{() => {
				const sides =
					props.diffStyle() === "split"
						? (["before", "after"] as const)
						: (["unified"] as const);
				return sides.map((_, index) => (
					<View
						class={classNames(
							"min-w-0 flex-1 py-2",
							index > 0 && "border-l border-border/60",
						)}
					>
						{SKELETON_LINE_WIDTHS.map((width) => (
							<View class="h-6 flex-row items-center gap-4 px-4">
								<Skeleton class="h-2.5 w-4 shrink-0 rounded-(--pilo-radius-sm)" />
								<View class="min-w-0 flex-1">
									<Skeleton
										class="h-3 rounded-(--pilo-radius-sm)"
										style={{ width: `${width}%` }}
									/>
								</View>
							</View>
						))}
					</View>
				));
			}}
		</View>
	);
}

function GitWorkspaceSkeleton(props: {
	wide: () => boolean;
	diffStyle: () => "unified" | "split";
	listSize: () => number;
}) {
	return (
		<View
			testID="git-workspace-skeleton"
			role="progressbar"
			accessible
			accessibilityLabel={t("file.readingGit")}
			class="min-h-0 min-w-0 flex-1 flex-row overflow-hidden"
		>
			<View
				class={classNames(
					"min-h-0 min-w-0 flex-col bg-muted/15",
					props.wide() ? "shrink-0 border-r border-border/60" : "flex-1",
				)}
				style={props.wide() ? { width: props.listSize() } : undefined}
			>
				<View class="min-h-10 shrink-0 flex-row items-center gap-2 px-3 py-1">
					<Skeleton class="h-8 flex-1" />
					<Skeleton class="h-8 flex-1" />
				</View>
				<View class="min-h-0 overflow-hidden px-2 pb-2">
					{SKELETON_FILE_WIDTHS.map((width) => (
						<View class="min-h-8 flex-row items-center gap-2.5 px-3 py-1.5">
							<Skeleton class="size-4 shrink-0" />
							<View class="min-w-0 flex-1">
								<Skeleton class="h-3" style={{ width: `${width}%` }} />
							</View>
							<Skeleton class="size-5 shrink-0" />
						</View>
					))}
				</View>
			</View>
			{() =>
				props.wide() ? (
					<View class="min-h-0 min-w-0 flex-1 flex-col">
						<View class="min-h-10 shrink-0 flex-row items-center gap-2 border-b border-border/60 px-3">
							<Skeleton class="size-5" />
							<Skeleton class="h-4 w-32" />
							<View class="min-w-0 flex-1">
								<Skeleton class="h-2.5 w-24" />
							</View>
							<Skeleton class="h-8 w-16" />
							<Skeleton class="size-8" />
						</View>
						<GitDiffSkeleton diffStyle={props.diffStyle} />
					</View>
				) : null
			}
		</View>
	);
}

/**
 * Desktop-only Git workspace view for one project: branch/count toolbar,
 * resizable working/staged file list, narrow list/detail navigation, and
 * native virtualized diff viewer.
 */
function GitWorkspacePanel(props: {
	projectId: string;
	visible: () => boolean;
	view: () => GitWorkspaceView;
	onViewChange: (view: Partial<GitWorkspaceView>) => void;
	git: GitWorkspaceClient;
	preferences: () => HostPreferenceValues | undefined;
	canOpenFile?: (path: string) => boolean;
	onOpenFile?: (path: string) => void;
}) {
	const snapshot = signal<{ revision: number; status: GitStatus } | null>(null);
	const loading = signal(true);
	const error = signal<string | null>(null);
	const revision = signal(0);
	const diffRetry = signal(0);
	const diff = signal<DiffResult | null>(null);

	const workspaceWidth = signal(0);
	const diffPaneWidth = signal(0);

	const wide = computed(() => workspaceWidth() >= WIDE_BREAKPOINT);
	const mode = computed(() => props.view().mode);
	const selectedPath = computed(() => props.view().selectedPath);
	const showDetail = computed(() => props.view().showDetail);
	const listWidthPct = computed(() => props.view().listWidth);
	const diffStyle = computed(() => props.view().diffStyle);
	const wrapLines = computed(() => props.view().wrapLines);

	const resolvedListSize = computed(() => {
		const width = workspaceWidth();
		const pct = listWidthPct();
		const max = Math.max(MIN_LIST_WIDTH, Math.floor(width * 0.5));
		if (pct === undefined || width <= 0) {
			return Math.min(DEFAULT_LIST_WIDTH, max);
		}
		return Math.min(
			max,
			Math.max(MIN_LIST_WIDTH, Math.round((width * pct) / 100)),
		);
	});

	const status = computed(() => snapshot()?.status ?? null);
	const userSelectedMode = signal(false);

	const workingCount = computed(
		() => (status()?.files ?? []).filter((file) => file.unstaged).length,
	);
	const stagedCount = computed(
		() => (status()?.files ?? []).filter((file) => file.staged).length,
	);
	const visibleFiles = computed(() => {
		const currentMode = mode();
		return (status()?.files ?? []).filter((file) =>
			currentMode === "staged" ? file.staged : file.unstaged,
		);
	});
	const totalLineChanges = computed(() => {
		const currentMode = mode();
		let total: LineChanges | null = null;
		for (const file of visibleFiles()) {
			const counts = lineChanges(file, currentMode);
			if (!counts) continue;
			total ??= { additions: 0, deletions: 0 };
			total.additions += counts.additions;
			total.deletions += counts.deletions;
		}
		return total;
	});
	const hasVisibleFiles = computed(() => visibleFiles().length > 0);
	const activePath = computed(() => {
		const files = visibleFiles();
		const preferred = selectedPath();
		return files.some((file) => file.path === preferred)
			? preferred
			: (files[0]?.path ?? null);
	});
	const selectedFile = computed(() => {
		const target = activePath();
		if (!target) return null;
		return visibleFiles().find((file) => file.path === target) ?? null;
	});
	const oneSidedChange = computed(() => {
		const file = selectedFile();
		if (!file) return false;
		const code = statusCode(file, mode());
		if (code === "?") return true;
		if (code !== "A" && code !== "D") return false;
		// AA, DD and any status containing U describe conflicts, not whole-file changes.
		return (
			file.indexStatus !== file.worktreeStatus &&
			file.indexStatus !== "U" &&
			file.worktreeStatus !== "U"
		);
	});
	const canSplit = computed(() => {
		const available = workspaceWidth() - (wide() ? resolvedListSize() : 0);
		return (
			!oneSidedChange() &&
			Math.min(available, diffPaneWidth()) >= SPLIT_MIN_WIDTH
		);
	});
	const effectiveDiffStyle = computed<"unified" | "split">(() =>
		canSplit() ? diffStyle() : "unified",
	);
	const filename = computed(() => {
		const target = activePath();
		if (!target) return null;
		return fileBasename(target) || target;
	});
	const currentDiff = computed(() => {
		const result = diff();
		const currentStatus = status();
		const target = activePath();
		if (
			!result ||
			!currentStatus ||
			!target ||
			result.path !== target ||
			result.mode !== mode() ||
			result.retry !== diffRetry()
		) {
			return null;
		}
		return result;
	});

	// Fetch status only when active or manually refreshed — never background poll.
	// 切回 Git 时采用 SWR 保留上次结果静默刷新，避免清空 Diff 闪骨架屏。
	const refreshingStatus = signal(false);
	effect(() => {
		const isVisible = props.visible();
		const currentRevision = revision();
		if (!isVisible) return;
		let cancelled = false;
		refreshingStatus.set(true);
		if (!untracked(snapshot)) loading.set(true);
		error.set(null);
		void untracked(() => props.git.getProjectGitStatus(props.projectId))
			.then((next) => {
				if (cancelled) return;
				const firstLoad = !untracked(snapshot);
				snapshot.set({ revision: currentRevision, status: next });
				loading.set(false);
				refreshingStatus.set(false);
				if (firstLoad && !untracked(userSelectedMode)) {
					const working = next.files.filter((file) => file.unstaged).length;
					const staged = next.files.filter((file) => file.staged).length;
					if (working === 0 && staged > 0 && untracked(mode) === "working") {
						props.onViewChange({ mode: "staged" });
					}
				}
			})
			.catch((cause: unknown) => {
				if (cancelled) return;
				snapshot.set(null);
				diff.set(null);
				error.set(gitErrorDetail(cause, t("file.gitRepoHint")));
				loading.set(false);
				refreshingStatus.set(false);
			});
		return () => {
			cancelled = true;
			refreshingStatus.set(false);
		};
	});

	// Fetch diff for the active file & mode tied to the current status snapshot.
	effect(() => {
		const isVisible = props.visible();
		const currentStatus = status();
		const target = activePath();
		const currentMode = mode();
		const isLoading = loading();
		const isRefreshing = refreshingStatus();
		const currentRetry = diffRetry();
		if (!isVisible || !currentStatus || !target || isLoading || isRefreshing)
			return;
		let cancelled = false;
		void untracked(() =>
			props.git.getProjectGitDiff(props.projectId, {
				path: target,
				staged: currentMode === "staged",
			}),
		)
			.then((text) => {
				if (cancelled) return;
				diff.set({
					retry: currentRetry,
					path: target,
					mode: currentMode,
					status: currentStatus,
					text,
				});
			})
			.catch((cause: unknown) => {
				if (cancelled) return;
				diff.set({
					retry: currentRetry,
					path: target,
					mode: currentMode,
					status: currentStatus,
					text: "",
					error: gitErrorDetail(cause, t("common.loadFailed")),
				});
			});
		return () => {
			cancelled = true;
		};
	});

	const refresh = () => {
		error.set(null);
		loading.set(true);
		revision.update((value) => value + 1);
	};

	const tooltip = (label: () => string) => (
		<Tooltip>
			<Text class="font-sans">{label}</Text>
		</Tooltip>
	);

	const totalFiles = computed(() => snapshot()?.status.files.length ?? 0);
	const branchName = computed(() => snapshot()?.status.branch || "Git");
	const showDetailOnly = computed(
		() => !wide() && Boolean(showDetail() && activePath()),
	);
	const listPanelVisible = computed(() => wide() || !showDetailOnly());
	const diffPanelVisible = computed(() => wide() || showDetailOnly());
	const maxListSize = computed(() => {
		const width = workspaceWidth();
		return width > 0
			? Math.max(MIN_LIST_WIDTH, Math.floor(width * 0.5))
			: undefined;
	});

	const fade = useEnterFade(props.visible);
	let resizeCommitTimer: ReturnType<typeof setTimeout> | undefined;
	cleanup(() => {
		if (resizeCommitTimer !== undefined) {
			clearTimeout(resizeCommitTimer);
			resizeCommitTimer = undefined;
		}
	});
	const scheduleListWidthCommit = (pct: number) => {
		if (resizeCommitTimer !== undefined) clearTimeout(resizeCommitTimer);
		resizeCommitTimer = setTimeout(() => {
			resizeCommitTimer = undefined;
			props.onViewChange({ listWidth: pct });
		}, 100);
	};

	return (
		<View
			testID={`git-workspace:${props.projectId}`}
			class="absolute inset-0 min-h-0 min-w-0 flex-col bg-background"
			style={[fade.style, { display: props.visible() ? "flex" : "none" }]}
			onLayout={({ bounds }) => {
				if (bounds.size.width > 0) workspaceWidth.set(bounds.size.width);
			}}
		>
			{/* Top changes/branch/refresh bar */}
			<View class="min-h-12 shrink-0 flex-row items-center gap-2 border-b border-border/60 px-4">
				<Text class="font-sans text-sm font-medium text-foreground">
					{() => t("file.changes")}
				</Text>
				<View
					testID="git-file-count"
					accessible
					accessibilityLabel={t("file.fileCount", { count: totalFiles() })}
					class="rounded-(--pilo-radius-md) bg-muted px-1.5 py-0.5"
				>
					<Text class="font-sans text-[11px] tabular-nums text-muted-foreground">
						{() => String(totalFiles())}
					</Text>
				</View>
				{() => {
					const counts = totalLineChanges();
					return counts ? (
						<View accessible accessibilityLabel={t("file.lineChanges", counts)}>
							<LineChangeCounts {...counts} />
						</View>
					) : null;
				}}
				<View class="ml-auto min-w-0 flex-row items-center gap-1">
					<View
						testID="git-branch-badge"
						class="mr-1 min-w-0 flex-row items-center gap-1.5 rounded-(--pilo-radius-md) bg-muted/50 px-2 py-1"
						tooltip={
							snapshot()?.status.branch
								? tooltip(() => snapshot()?.status.branch ?? "")
								: undefined
						}
					>
						<Icon
							name="GitBranch"
							size={14}
							color={token("muted-foreground")}
						/>
						<Text class="max-w-48 truncate font-sans text-xs text-muted-foreground">
							{branchName}
						</Text>
					</View>
					<Button
						testID="git-refresh"
						variant="ghost"
						size="icon"
						class="size-8"
						disabled={loading()}
						accessibilityLabel={t("file.gitRefresh")}
						tooltip={tooltip(() => t("file.gitRefresh"))}
						onPress={refresh}
					>
						<Icon
							name="RefreshCw"
							size={14}
							color={token("muted-foreground")}
							class={loading() ? "animate-spin" : undefined}
						/>
					</Button>
				</View>
			</View>

			{/* Main body */}
			{() => {
				const err = error();
				if (err) {
					return (
						<View class="min-h-0 flex-1 items-center justify-center">
							<ErrorState
								testID="git-status-error"
								title={() => t("file.gitReadFailed")}
								description={() => err}
								onRetry={refresh}
								retryLabel={() => t("common.retry")}
								retryTestID="git-status-retry"
							/>
						</View>
					);
				}
				if (loading() && !status()) {
					return (
						<GitWorkspaceSkeleton
							wide={wide}
							diffStyle={effectiveDiffStyle}
							listSize={resolvedListSize}
						/>
					);
				}
				return (
					<ResizablePanelGroup
						axis="horizontal"
						disabled={!wide()}
						class="min-h-0 min-w-0 flex-1"
						handleClass="bg-border/60 group-hover:bg-ring/60 group-active:bg-ring transition-colors duration-[110ms]"
						handleAccessibilityLabel={t("file.resizePanels")}
						onResize={({ sizes }) => {
							const width = untracked(workspaceWidth);
							const listSize = sizes[0];
							if (!untracked(wide) || width <= 0 || listSize === undefined) {
								return;
							}
							const pct = Math.min(50, (listSize / width) * 100);
							scheduleListWidthCommit(pct);
						}}
					>
						{/* Left file list panel */}
						<ResizablePanel
							size={wide() ? resolvedListSize() : undefined}
							minSize={wide() ? MIN_LIST_WIDTH : 0}
							maxSize={wide() ? maxListSize() : undefined}
							visible={listPanelVisible()}
							class="min-h-0 min-w-0 flex-col bg-muted/15"
						>
							<View
								testID="git-file-list-pane"
								class="min-h-0 min-w-0 flex-1 flex-col"
							>
								{/* Working tree / Staged segmented selector */}
								<View class="min-h-10 shrink-0 justify-center px-3 py-1">
									<Tabs
										orientation="horizontal"
										accessibilityLabel={t("file.changes")}
										class="h-auto w-full min-w-0 gap-0.5 rounded-(--pilo-radius-lg) bg-muted/70 p-0.5"
										indicatorClass="inset-y-0.5 rounded-(--pilo-radius-md) bg-background"
										indicatorStyle={{
											boxShadow: styleVar("pilo-button-secondary-shadow"),
										}}
									>
										{(["working", "staged"] as const).map((value) => {
											const isSelected = () => mode() === value;
											const count = () =>
												value === "staged" ? stagedCount() : workingCount();
											const pointerBlur = blurOnPointerPress();
											return (
												<Tab
													testID={`git-mode-${value}`}
													ref={pointerBlur.ref}
													onMouseUp={pointerBlur.onMouseUp}
													selected={isSelected()}
													class={classNames(
														"h-8 min-w-0 flex-1 gap-2 rounded-(--pilo-radius-md) px-2 py-0",
														!isSelected() && "hover:bg-hover/40",
													)}
													style={tactileTransition("background-color, color")}
													focusVisibleStyle={focusRingStyle(token("ring"))}
													onPress={() => {
														userSelectedMode.set(true);
														props.onViewChange({
															mode: value,
															showDetail: false,
														});
													}}
												>
													<Text
														class={classNames(
															"truncate font-sans text-xs font-medium",
															isSelected()
																? "text-foreground"
																: "text-muted-foreground",
														)}
													>
														{() =>
															value === "working"
																? t("file.workingTree")
																: t("file.staged")
														}
													</Text>
													<Text class="font-sans text-[11px] tabular-nums text-muted-foreground">
														{() => String(count())}
													</Text>
												</Tab>
											);
										})}
									</Tabs>
								</View>

								{/* Changed files list */}
								<List
									testID="git-file-list"
									class="min-h-0 flex-1"
									contentClass="px-2"
									contentStyle={{ gap: 2 }}
									bounces={false}
									scrollbar={scrollbarTheme({ vertical: scrollbarLook() })}
									each={visibleFiles()}
									keyExtractor={(file) => file.path}
									estimatedItemSize={34}
									empty={() => (
										<EmptyState
											testID="git-files-empty"
											variant="compact"
											icon={
												<Icon
													name="CheckCheck"
													size={16}
													color={token("status-success")}
												/>
											}
											title={() => t("file.noChanges")}
											description={() =>
												mode() === "working"
													? t("file.workingClean")
													: t("file.stagedClean")
											}
										/>
									)}
								>
									{(entry) => {
										const path = () => entry().path;
										const name = () => {
											const currentPath = path();
											return currentPath.slice(
												currentPath.lastIndexOf("/") + 1,
											);
										};
										const hintText = () => {
											const current = entry();
											return current.originalPath
												? `${current.originalPath} → ${current.path}`
												: current.path;
										};
										const selected = () => activePath() === path();
										const counts = computed(() => lineChanges(entry(), mode()));
										const label = () => {
											const changes = counts();
											return changes
												? `${hintText()} · ${t("file.lineChanges", changes)}`
												: hintText();
										};
										const pointerBlur = blurOnPointerPress();
										return (
											<BaseButton
												testID={`git-file-row:${path()}`}
												ref={pointerBlur.ref}
												onMouseUp={pointerBlur.onMouseUp}
												selected={selected()}
												accessibilityLabel={label()}
												tooltip={
													<Tooltip>
														<Text class="font-mono text-xs">{hintText}</Text>
													</Tooltip>
												}
												class={classNames(
													"min-h-8 w-full flex-row items-center gap-2.5 rounded-(--pilo-radius-md) px-3 py-1.5 transition-colors focus-visible:outline-hidden",
													selected() ? "bg-muted" : "hover:bg-hover/70",
												)}
												focusVisibleStyle={focusRingStyle(token("ring"))}
												onPress={() =>
													props.onViewChange({
														selectedPath: path(),
														showDetail: true,
													})
												}
											>
												<Icon
													name="FileCode"
													size={16}
													color={token("muted-foreground")}
												/>
												<Text class="min-w-0 flex-1 truncate font-sans text-xs font-medium text-foreground">
													{name}
												</Text>
												{() => {
													const changes = counts();
													return changes ? (
														<LineChangeCounts {...changes} />
													) : null;
												}}
												<FileStatusBadge file={entry} mode={mode} />
											</BaseButton>
										);
									}}
								</List>
							</View>
						</ResizablePanel>

						{/* Right diff detail panel */}
						<ResizablePanel
							minSize={wide() ? MIN_DIFF_WIDTH : 0}
							visible={diffPanelVisible()}
							class="min-h-0 min-w-0 flex-col"
						>
							<View
								testID="git-diff-pane"
								class="min-h-0 min-w-0 flex-1 flex-col"
								onLayout={({ bounds }) => {
									if (bounds.size.width > 0) {
										diffPaneWidth.set(bounds.size.width);
									}
								}}
							>
								{/* Selected file toolbar */}
								<View class="min-h-10 shrink-0 flex-row items-center gap-2 border-b border-border/60 px-3">
									{() =>
										!wide() ? (
											<Button
												testID="git-back-to-list"
												variant="ghost"
												size="icon"
												class="size-8 shrink-0"
												accessibilityLabel={t("common.back")}
												onPress={() =>
													props.onViewChange({ showDetail: false })
												}
											>
												<Icon
													name="ArrowLeft"
													size={16}
													color={token("muted-foreground")}
												/>
											</Button>
										) : null
									}
									{() => {
										const current = selectedFile();
										return current ? (
											<FileStatusBadge file={() => current} mode={mode} />
										) : (
											<Icon
												name="FileCode"
												size={16}
												color={token("muted-foreground")}
											/>
										);
									}}
									<Text
										testID="git-selected-filename"
										class="min-w-0 max-w-[40%] shrink truncate font-sans text-sm font-medium text-foreground"
									>
										{() => filename() ?? t("file.changes")}
									</Text>
									<View class="min-w-0 flex-1 flex-row items-center">
										{() => {
											const path = activePath();
											if (!path) return null;
											const file = selectedFile();
											const deleted =
												file &&
												(file.worktreeStatus === "D" ||
													(file.indexStatus === "D" && !file.unstaged));
											const canOpen = Boolean(
												!deleted &&
												props.onOpenFile &&
												(props.canOpenFile?.(path) ?? true),
											);
											const pointerBlur = blurOnPointerPress();
											return (
												<BaseButton
													testID="git-open-file"
													ref={pointerBlur.ref}
													onMouseUp={pointerBlur.onMouseUp}
													disabled={!canOpen}
													class={classNames(
														"min-h-8 min-w-0 shrink justify-center rounded-(--pilo-radius-sm) focus-visible:outline-hidden",
														canOpen && "hover:opacity-80",
													)}
													focusVisibleStyle={focusRingStyle(token("ring"))}
													tooltip={
														canOpen
															? tooltip(() => t("file.previewFile"))
															: undefined
													}
													onPress={() => {
														if (canOpen) props.onOpenFile?.(path);
													}}
												>
													<Text
														class={classNames(
															"truncate font-sans text-[11px] text-muted-foreground",
															canOpen && "hover:underline",
														)}
													>
														{path}
													</Text>
												</BaseButton>
											);
										}}
									</View>
									{/* Unified / Split diff toggle */}
									<View
										role="group"
										accessibilityLabel={t("file.diffLayout")}
										class="min-w-0 shrink-0 flex-row items-center gap-0.5 rounded-(--pilo-radius-md) bg-muted/50 p-0.5"
										style={{ display: oneSidedChange() ? "none" : "flex" }}
									>
										{(["unified", "split"] as const).map((layout) => {
											const iconName =
												layout === "split" ? "Columns2" : "Rows2";
											const labelKey =
												layout === "split"
													? "file.splitDiff"
													: "file.unifiedDiff";
											const active = () => effectiveDiffStyle() === layout;
											const disabled = () =>
												!activePath() || (layout === "split" && !canSplit());
											return (
												<Button
													testID={`git-diff-layout-${layout}`}
													variant="ghost"
													size="icon"
													selected={active()}
													disabled={disabled()}
													accessibilityLabel={t(labelKey)}
													tooltip={tooltip(() => t(labelKey))}
													class={classNames(
														"size-7",
														active() && "bg-background hover:bg-background",
													)}
													style={
														active()
															? {
																	boxShadow: styleVar(
																		"pilo-button-secondary-shadow",
																	),
																}
															: undefined
													}
													onPress={() =>
														props.onViewChange({ diffStyle: layout })
													}
												>
													<Icon
														name={iconName}
														size={14}
														color={token(
															active() ? "foreground" : "muted-foreground",
														)}
													/>
												</Button>
											);
										})}
									</View>
									{/* Wrap lines toggle */}
									<Button
										testID="git-diff-wrap"
										variant="ghost"
										size="icon"
										selected={wrapLines()}
										disabled={!activePath()}
										accessibilityLabel={t("file.wrapLines")}
										tooltip={tooltip(() => t("file.wrapLines"))}
										class={classNames(
											"size-8 shrink-0",
											wrapLines() && "bg-muted",
										)}
										onPress={() =>
											props.onViewChange({ wrapLines: !wrapLines() })
										}
									>
										<Icon
											name="WrapText"
											size={14}
											color={token(
												wrapLines() ? "foreground" : "muted-foreground",
											)}
										/>
									</Button>
								</View>

								{/* Diff content area */}
								{() => {
									const target = activePath();
									if (!target) {
										return (
											<EmptyState
												testID="git-diff-clean"
												class="flex-1"
												icon={
													<Icon
														name="CheckCheck"
														size={16}
														color={token("status-success")}
													/>
												}
												title={() => t("file.noDiff")}
												description={() =>
													visibleFiles().length === 0
														? t("file.noFilesToDiff")
														: t("file.selectFileToDiff")
												}
											/>
										);
									}
									const resolved = currentDiff();
									if (loading() || !resolved) {
										return <GitDiffSkeleton diffStyle={effectiveDiffStyle} />;
									}
									if (resolved.error) {
										const errorText = resolved.error;
										return (
											<View class="min-h-0 flex-1 items-center justify-center">
												<ErrorState
													testID="git-diff-error"
													title={() => t("file.diffReadFailed")}
													description={() => errorText}
													onRetry={() => {
														diff.set(null);
														diffRetry.update((value) => value + 1);
													}}
													retryLabel={() => t("common.retry")}
													retryTestID="git-diff-retry"
												/>
											</View>
										);
									}
									return (
										<GitDiffViewer
											diff={() => resolved.text}
											path={() => target}
											diffStyle={effectiveDiffStyle}
											wrapLines={wrapLines}
											preferences={props.preferences}
										/>
									);
								}}
							</View>
						</ResizablePanel>
					</ResizablePanelGroup>
				);
			}}
		</View>
	);
}

/**
 * Overlay layer for open project Git tabs; keeps chat mounted behind it
 * so switching tabs preserves conversation scroll position and project state.
 */
export function GitWorkspaceLayer(props: {
	workspace: WorkspaceStore;
	activeProjectId: () => string | null;
	git: GitWorkspaceClient;
	preferences: () => HostPreferenceValues | undefined;
	canOpenFile?: (path: string) => boolean;
	onOpenFile?: (path: string) => void;
}) {
	return (
		<View
			testID="git-workspace-layer"
			class="absolute inset-0 z-30 bg-background"
			style={{ display: props.activeProjectId() ? "flex" : "none" }}
		>
			<Each of={props.workspace.openGitProjectIds()} key={(id) => id}>
				{(projectId) => {
					const id = untracked(projectId);
					const isVisible = () => props.activeProjectId() === id;
					return (
						<GitWorkspacePanel
							projectId={id}
							visible={isVisible}
							view={() => props.workspace.gitView(id)}
							onViewChange={(patch) => props.workspace.updateGitView(id, patch)}
							git={props.git}
							preferences={props.preferences}
							canOpenFile={props.canOpenFile}
							onOpenFile={props.onOpenFile}
						/>
					);
				}}
			</Each>
		</View>
	);
}
