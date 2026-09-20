import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
	Folder,
	LoaderCircle,
	MessageSquareText,
	MessagesSquare,
} from "lucide-react";

import {
	listSessions,
	searchSessions,
	type SessionIndexEntry,
} from "@/lib/sessions";
import {
	CommandDialog,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	Hint,
} from "@/ui";
import type { SidebarProject, SidebarSession } from "./sidebar/types";

export type SessionSearchTarget = {
	sessionId: string;
	projectId: string;
	sessionPath: string;
	title: string;
};

type CommandPaletteProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projects: SidebarProject[];
	sessions: SidebarSession[];
	onSelectProject?: (projectId: string) => void;
	onSelectSession?: (target: SessionSearchTarget) => void;
};

function Kbd({ children }: { children: ReactNode }) {
	return (
		<kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-sm bg-muted px-1 font-sans text-[11px] font-medium text-muted-foreground select-none">
			{children}
		</kbd>
	);
}

function sessionsByRecent(sessions: readonly SidebarSession[]) {
	return sessions.reduce<SidebarSession[]>((ordered, session) => {
		const index = ordered.findIndex(
			(candidate) =>
				candidate.latestMessageAt.getTime() < session.latestMessageAt.getTime(),
		);
		if (index < 0) ordered.push(session);
		else ordered.splice(index, 0, session);
		return ordered;
	}, []);
}

function indexedTitle(session: SessionIndexEntry) {
	return (
		session.titleOverride ??
		session.name ??
		session.firstUserMessagePreview ??
		"新会话"
	);
}

export function CommandPalette({
	open,
	onOpenChange,
	projects,
	sessions,
	onSelectProject,
	onSelectSession,
}: CommandPaletteProps) {
	const [query, setQuery] = useState("");
	const [catalog, setCatalog] = useState<SidebarSession[]>(sessions);
	const [contentResults, setContentResults] = useState<
		Array<SessionSearchTarget & { snippet: string; role: "user" | "assistant" }>
	>([]);
	const [searchingContent, setSearchingContent] = useState(false);
	const requestRef = useRef(0);

	useEffect(() => {
		if (!open) return;
		let disposed = false;
		void Promise.allSettled(
			projects.map((project) => listSessions(project.id)),
		).then((results) => {
			if (disposed) return;
			const byKey = new Map(
				sessions.map((session) => [
					`${session.projectId}\0${session.sessionPath || session.id}`,
					session,
				]),
			);
			for (const result of results) {
				if (result.status !== "fulfilled") continue;
				for (const session of result.value) {
					const key = `${session.projectId}\0${session.sessionPath}`;
					if (byKey.has(key)) continue;
					byKey.set(key, {
						id: session.piSessionId,
						title: indexedTitle(session),
						preview:
							session.titleOverride || session.name
								? session.firstUserMessagePreview
								: null,
						sessionPath: session.sessionPath,
						projectId: session.projectId,
						latestMessageAt: new Date(
							session.lastMessageAt ?? session.updatedAt ?? session.createdAt,
						),
					});
				}
			}
			setCatalog([...byKey.values()]);
		});
		return () => {
			disposed = true;
		};
	}, [open, projects, sessions]);

	useEffect(() => {
		if (!open) return;
		let disposed = false;
		const normalized = query.trim();
		requestRef.current += 1;
		const request = requestRef.current;
		if (normalized.length < 2) return;
		const timer = window.setTimeout(() => {
			void Promise.allSettled(
				projects.map(async (project) => ({
					project,
					matches: await searchSessions(project.id, normalized, 12),
				})),
			).then((results) => {
				if (disposed || requestRef.current !== request) return;
				const known = new Map(
					catalog.map((session) => [
						`${session.projectId}\0${session.sessionPath}`,
						session,
					]),
				);
				const next = results.flatMap((result) => {
					if (result.status !== "fulfilled") return [];
					return result.value.matches.map((match) => {
						const session = known.get(
							`${result.value.project.id}\0${match.sessionPath}`,
						);
						return {
							sessionId: session?.id ?? match.sessionId,
							projectId: result.value.project.id,
							sessionPath: match.sessionPath,
							title: session?.title ?? "会话",
							snippet: match.snippet,
							role: match.role,
						};
					});
				});
				setContentResults(next.slice(0, 30));
				setSearchingContent(false);
			});
		}, 220);
		return () => {
			disposed = true;
			window.clearTimeout(timer);
		};
	}, [catalog, open, projects, query]);

	const normalized = query.trim().toLocaleLowerCase();
	const projectById = useMemo(
		() => new Map(projects.map((project) => [project.id, project])),
		[projects],
	);
	const projectResults = useMemo(() => {
		if (!normalized) return projects.slice(0, 8);
		return projects.filter((project) =>
			[project.name, project.path]
				.join("\n")
				.toLocaleLowerCase()
				.includes(normalized),
		);
	}, [normalized, projects]);
	const sessionResults = useMemo(() => {
		const ordered = sessionsByRecent(catalog);
		if (!normalized) return ordered.slice(0, 18);
		return ordered.filter((session) => {
			const project = projectById.get(session.projectId);
			return [
				session.title,
				session.preview ?? "",
				session.sessionPath,
				project?.name ?? "",
			]
				.join("\n")
				.toLocaleLowerCase()
				.includes(normalized);
		});
	}, [catalog, normalized, projectById]);

	const chooseSession = (target: SessionSearchTarget) => {
		onSelectSession?.(target);
		onOpenChange(false);
	};
	const hasResults =
		projectResults.length > 0 ||
		sessionResults.length > 0 ||
		contentResults.length > 0;

	return (
		<CommandDialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					requestRef.current += 1;
					setQuery("");
					setContentResults([]);
					setSearchingContent(false);
				}
				onOpenChange(next);
			}}
			shouldFilter={false}
		>
			<CommandInput
				value={query}
				onValueChange={(value) => {
					setQuery(value);
					if (value.trim().length < 2) {
						requestRef.current += 1;
						setContentResults([]);
						setSearchingContent(false);
					} else {
						setSearchingContent(true);
					}
				}}
				placeholder="搜索项目、会话或消息…"
			/>
			{!hasResults && !searchingContent ? (
				<div className="flex flex-1 items-center justify-center px-4 text-sm text-muted-foreground">
					没有找到相关内容
				</div>
			) : (
				<CommandList
					className="px-0 py-1.5"
					containerClassName="max-h-none min-h-0 flex-1"
					viewportClassName="max-h-none h-full"
				>
					{projectResults.length > 0 ? (
						<CommandGroup heading="项目">
							{projectResults.map((project) => (
								<CommandItem
									key={`project:${project.id}`}
									value={`project:${project.id}`}
									onSelect={() => {
										onSelectProject?.(project.id);
										onOpenChange(false);
									}}
									className="mx-1.5 my-px gap-2.5 py-2"
								>
									<Folder className="size-4 shrink-0 text-muted-foreground" />
									<div className="min-w-0 flex-1">
										<Hint label={project.name}>
											<div className="truncate text-sm">{project.name}</div>
										</Hint>
										<Hint label={project.path}>
											<div className="truncate text-[11px] text-muted-foreground">
												{project.path}
											</div>
										</Hint>
									</div>
								</CommandItem>
							))}
						</CommandGroup>
					) : null}
					{sessionResults.length > 0 ? (
						<CommandGroup heading={normalized ? "会话" : "最近会话"}>
							{sessionResults.map((session) => (
								<CommandItem
									key={`session:${session.projectId}:${session.id}`}
									value={`session:${session.projectId}:${session.id}`}
									onSelect={() =>
										chooseSession({
											sessionId: session.id,
											projectId: session.projectId,
											sessionPath: session.sessionPath,
											title: session.title,
										})
									}
									className="mx-1.5 my-px gap-2.5 py-2"
								>
									<MessagesSquare className="size-4 shrink-0 text-muted-foreground" />
									<div className="min-w-0 flex-1">
										<div className="flex min-w-0 items-center gap-2">
											<Hint label={session.title}>
												<span className="truncate text-sm">
													{session.title}
												</span>
											</Hint>
											{session.active ? (
												<span className="size-1.5 shrink-0 rounded-full bg-status-success" />
											) : null}
										</div>
										<Hint
											label={`${projectById.get(session.projectId)?.name ?? "项目"}${session.preview ? ` · ${session.preview}` : ""}`}
										>
											<div className="truncate text-[11px] text-muted-foreground">
												{projectById.get(session.projectId)?.name ?? "项目"}
												{session.preview ? ` · ${session.preview}` : ""}
											</div>
										</Hint>
									</div>
								</CommandItem>
							))}
						</CommandGroup>
					) : null}
					{contentResults.length > 0 ? (
						<CommandGroup heading="消息内容">
							{contentResults.map((result) => (
								<CommandItem
									key={`content:${result.projectId}:${result.sessionPath}:${result.role}:${result.snippet}`}
									value={`content:${result.projectId}:${result.sessionPath}:${result.role}:${result.snippet}`}
									onSelect={() => chooseSession(result)}
									className="mx-1.5 my-px items-start gap-2.5 py-2"
								>
									<MessageSquareText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
									<div className="min-w-0 flex-1">
										<Hint label={result.title}>
											<div className="truncate text-xs font-medium text-foreground/90">
												{result.title}
												<span className="ml-2 font-normal text-muted-foreground">
													{result.role === "user" ? "你" : "Agent"}
												</span>
											</div>
										</Hint>
										<Hint label={result.snippet}>
											<div className="mt-0.5 line-clamp-2 text-[11px] leading-[1.45] text-muted-foreground">
												{result.snippet}
											</div>
										</Hint>
									</div>
								</CommandItem>
							))}
						</CommandGroup>
					) : null}
				</CommandList>
			)}
			<footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-[11px] text-muted-foreground">
				{searchingContent ? (
					<span className="flex items-center gap-1.5">
						<LoaderCircle className="size-3 animate-spin" />
						正在搜索历史消息
					</span>
				) : (
					<div className="flex items-center gap-3">
						<span className="flex items-center gap-1">
							<Kbd>↑</Kbd>
							<Kbd>↓</Kbd>
							切换
						</span>
						<span className="flex items-center gap-1">
							<Kbd>↵</Kbd>
							选择
						</span>
					</div>
				)}
				<span className="flex items-center gap-1">
					<Kbd>esc</Kbd>
					关闭
				</span>
			</footer>
		</CommandDialog>
	);
}
