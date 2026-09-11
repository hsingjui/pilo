import { useCallback, useEffect, useMemo, useState } from "react";
import {
	ChevronRight,
	File,
	FileCode,
	Folder,
	FolderOpen,
	RefreshCw,
	Search,
} from "lucide-react";

import {
	readWorkspaceDir,
	searchWorkspaceFiles,
	type FsEntry,
} from "@/lib/files";
import { cn } from "@/lib/utils";
import type { Workspace } from "@/lib/workspaces";
import { Button, EmptyState, ErrorState, Input } from "@/ui";

type DirectoryState = {
	entries: FsEntry[];
	loading: boolean;
	error?: string;
};

function FileEntryIcon({
	entry,
	expanded,
}: {
	entry: FsEntry;
	expanded: boolean;
}) {
	const className = "size-3.5 shrink-0 text-sidebar-foreground-muted";
	if (entry.kind === "directory") {
		return expanded ? (
			<FolderOpen className={className} />
		) : (
			<Folder className={className} />
		);
	}
	const codeFile =
		/\.(?:[cm]?[jt]sx?|rs|go|py|java|kt|swift|vue|svelte|css|scss|html|json|ya?ml|toml|md)$/i.test(
			entry.name,
		);
	return codeFile ? (
		<FileCode className={className} />
	) : (
		<File className={className} />
	);
}

function FileTreeRow({
	entry,
	depth,
	expandedPaths,
	directories,
	onToggle,
	onOpenFile,
}: {
	entry: FsEntry;
	depth: number;
	expandedPaths: ReadonlySet<string>;
	directories: ReadonlyMap<string, DirectoryState>;
	onToggle: (entry: FsEntry) => void;
	onOpenFile: (path: string) => void;
}) {
	const directory = entry.kind === "directory";
	const expanded = expandedPaths.has(entry.path);
	const state = directories.get(entry.path);
	return (
		<>
			<button
				type="button"
				className="flex h-7 w-full items-center gap-1 rounded-md pr-2 text-left text-xs text-sidebar-foreground transition-colors hover:bg-sidebar-accent"
				style={{ paddingLeft: `${6 + depth * 12}px` }}
				onClick={() => (directory ? onToggle(entry) : onOpenFile(entry.path))}
			>
				{directory ? (
					<ChevronRight
						className={cn(
							"size-3 shrink-0 transition-transform",
							expanded && "rotate-90",
						)}
					/>
				) : (
					<span className="w-3 shrink-0" />
				)}
				<FileEntryIcon entry={entry} expanded={expanded} />
				<span className="min-w-0 flex-1 truncate">{entry.name}</span>
			</button>
			{directory && expanded ? (
				<div>
					{state?.loading ? (
						<div
							className="py-1 text-[11px] text-muted-foreground"
							style={{ paddingLeft: `${30 + depth * 12}px` }}
						>
							加载中…
						</div>
					) : state?.error ? (
						<div
							className="py-1 text-[11px] text-destructive"
							style={{ paddingLeft: `${30 + depth * 12}px` }}
						>
							{state.error}
						</div>
					) : (
						state?.entries.map((child) => (
							<FileTreeRow
								key={child.path}
								entry={child}
								depth={depth + 1}
								expandedPaths={expandedPaths}
								directories={directories}
								onToggle={onToggle}
								onOpenFile={onOpenFile}
							/>
						))
					)}
				</div>
			) : null}
		</>
	);
}

export function FileExplorer({
	workspace,
	onOpenFile,
}: {
	workspace: Workspace;
	onOpenFile: (path: string) => void;
}) {
	const [directories, setDirectories] = useState<Map<string, DirectoryState>>(
		() => new Map([["", { entries: [], loading: true }]]),
	);
	const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
		() => new Set(),
	);
	const [query, setQuery] = useState("");
	const [searchResults, setSearchResults] = useState<string[]>([]);
	const [searching, setSearching] = useState(false);
	const root = directories.get("");

	const loadDirectory = useCallback(
		async (path: string) => {
			setDirectories((current) => {
				const next = new Map(current);
				next.set(path, {
					entries: current.get(path)?.entries ?? [],
					loading: true,
				});
				return next;
			});
			try {
				const entries = await readWorkspaceDir(workspace.id, path);
				setDirectories((current) => {
					const next = new Map(current);
					next.set(path, { entries, loading: false });
					return next;
				});
			} catch (error) {
				setDirectories((current) => {
					const next = new Map(current);
					next.set(path, {
						entries: current.get(path)?.entries ?? [],
						loading: false,
						error: error instanceof Error ? error.message : String(error),
					});
					return next;
				});
			}
		},
		[workspace.id],
	);

	useEffect(() => {
		const timer = window.setTimeout(() => void loadDirectory(""), 0);
		return () => window.clearTimeout(timer);
	}, [loadDirectory]);

	useEffect(() => {
		const value = query.trim();
		if (!value) {
			const timer = window.setTimeout(() => {
				setSearchResults([]);
				setSearching(false);
			}, 0);
			return () => window.clearTimeout(timer);
		}
		const timer = window.setTimeout(() => {
			setSearching(true);
			void searchWorkspaceFiles(workspace.id, value)
				.then(setSearchResults)
				.catch(() => setSearchResults([]))
				.finally(() => setSearching(false));
		}, 180);
		return () => window.clearTimeout(timer);
	}, [query, workspace.id]);

	const toggleDirectory = useCallback(
		(entry: FsEntry) => {
			const expanding = !expandedPaths.has(entry.path);
			setExpandedPaths((current) => {
				const next = new Set(current);
				if (next.has(entry.path)) next.delete(entry.path);
				else next.add(entry.path);
				return next;
			});
			if (expanding && !directories.has(entry.path)) {
				void loadDirectory(entry.path);
			}
		},
		[directories, expandedPaths, loadDirectory],
	);

	const rootEntries = useMemo(() => root?.entries ?? [], [root?.entries]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex shrink-0 items-center gap-1.5 p-2">
				<div className="relative min-w-0 flex-1">
					<Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
					<Input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="搜索文件"
						className="h-7 pl-7 text-xs"
					/>
				</div>
				<Button
					variant="ghost"
					size="icon"
					className="size-7 shrink-0"
					aria-label="刷新文件"
					onClick={() => void loadDirectory("")}
				>
					<RefreshCw
						className={cn("size-3.5", root?.loading && "animate-spin")}
					/>
				</Button>
			</div>
			<div className="scrollbar-pro min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
				{query.trim() ? (
					searching ? (
						<div className="px-2 py-4 text-center text-xs text-muted-foreground">
							搜索中…
						</div>
					) : searchResults.length ? (
						<ul className="grid gap-0.5">
							{searchResults.map((path) => (
								<li key={path}>
									<button
										type="button"
										className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-xs hover:bg-sidebar-accent"
										onClick={() => onOpenFile(path)}
									>
										<FileCode className="size-3.5 shrink-0 text-sidebar-foreground-muted" />
										<span className="min-w-0 flex-1 truncate">{path}</span>
									</button>
								</li>
							))}
						</ul>
					) : (
						<EmptyState variant="compact" title="没有匹配文件" />
					)
				) : root?.error ? (
					<ErrorState
						variant="compact"
						title="无法读取文件"
						description={root.error}
						onRetry={() => void loadDirectory("")}
					/>
				) : root?.loading && rootEntries.length === 0 ? (
					<div className="px-2 py-4 text-center text-xs text-muted-foreground">
						正在读取文件…
					</div>
				) : rootEntries.length === 0 ? (
					<EmptyState variant="compact" title="工作区为空" />
				) : (
					rootEntries.map((entry) => (
						<FileTreeRow
							key={entry.path}
							entry={entry}
							depth={0}
							expandedPaths={expandedPaths}
							directories={directories}
							onToggle={toggleDirectory}
							onOpenFile={onOpenFile}
						/>
					))
				)}
			</div>
		</div>
	);
}
