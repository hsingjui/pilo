import { useEffect, useMemo, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { Search, SquarePen, Wifi, WifiOff, X } from "lucide-react";

import {
	CommandPalette,
	type SessionSearchTarget,
} from "@/components/command-palette";
import {
	sortSidebarSessionsActiveFirst,
	sortSidebarSessionsByRecency,
} from "@/components/sidebar/session-list";
import type {
	SidebarEnv,
	SidebarEnvView,
	SidebarProject,
	SidebarSession,
} from "@/components/sidebar/types";
import type { PiloClient } from "@/lib/api/pilo-client";
import { cn } from "@/lib/utils";
import {
	remoteConnectionLabelKey,
	type RemoteConnectionState,
} from "@/remote/remote-connection-state";
import {
	MobileEnvRow,
	MobileProjectRow,
	MobileSessionRow,
	ROW_ACTION_CLASS,
} from "@/remote/remote-mobile-rows";

/** “最近会话”视图最多展示的会话数，与桌面侧栏保持一致。 */
const RECENT_SESSION_LIMIT = 50;
const PROJECT_SESSION_BATCH_SIZE = 50;

function MobileSessionLoadSentinel({ onLoadMore }: { onLoadMore: () => void }) {
	const sentinelRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const sentinel = sentinelRef.current;
		if (!sentinel) return;
		if (typeof IntersectionObserver === "undefined") {
			const frame = requestAnimationFrame(onLoadMore);
			return () => cancelAnimationFrame(frame);
		}

		const observer = new IntersectionObserver(
			(entries) => {
				if (!entries.some((entry) => entry.isIntersecting)) return;
				observer.disconnect();
				onLoadMore();
			},
			{
				root: sentinel.closest("[data-mobile-session-scroll]"),
				rootMargin: "0px 0px 240px 0px",
			},
		);
		observer.observe(sentinel);
		return () => observer.disconnect();
	}, [onLoadMore]);

	return <div ref={sentinelRef} className="h-px" aria-hidden="true" />;
}

export function RemoteMobileNavigation({
	client,
	open,
	onOpenChange,
	envs,
	projects,
	sessions,
	activeProjectId,
	selectedSessionId,
	connectionState,
	refreshingProjectIds,
	onSelectSession,
	onNewChat,
	onRefreshProjectSessions,
	onDeleteSession,
	onRefreshSession,
}: {
	client: PiloClient | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	envs: SidebarEnv[];
	projects: SidebarProject[];
	sessions: SidebarSession[];
	activeProjectId: string | null;
	selectedSessionId: string | null;
	connectionState: RemoteConnectionState;
	refreshingProjectIds: ReadonlySet<string>;
	onSelectSession: (sessionId: string, projectId: string) => void;
	onNewChat: (projectId?: string) => void;
	onRefreshProjectSessions: (projectId: string) => void;
	onDeleteSession: (sessionId: string, projectId: string) => void;
	onRefreshSession: (sessionId: string, projectId: string) => Promise<void>;
}) {
	const { t } = useTranslation();
	const [mode, setMode] = useState<SidebarEnvView>("projects");
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [projectSessionLimits, setProjectSessionLimits] = useState<
		Record<string, number>
	>({});
	const [loadSelection, setLoadSelection] = useState({
		activeProjectId,
		selectedSessionId,
	});
	const [confirmDeleteSessionId, setConfirmDeleteSessionId] = useState<
		string | null
	>(null);
	// 未出现的 key 走默认值：连接展开、项目折叠（当前项目例外）。
	const [sectionOverrides, setSectionOverrides] = useState<
		Record<string, boolean>
	>({});

	if (!open && confirmDeleteSessionId !== null) {
		setConfirmDeleteSessionId(null);
	}

	// Reset only the newly selected project's limit before revealing its session.
	if (
		loadSelection.activeProjectId !== activeProjectId ||
		loadSelection.selectedSessionId !== selectedSessionId
	) {
		setLoadSelection({ activeProjectId, selectedSessionId });
		if (activeProjectId) {
			setProjectSessionLimits((current) => {
				const next = { ...current };
				delete next[activeProjectId];
				return next;
			});
		}
	}

	const toggleSection = (key: string, defaultExpanded: boolean) =>
		setSectionOverrides((current) => ({
			...current,
			[key]: !(current[key] ?? defaultExpanded),
		}));

	const projectsByEnv = useMemo(() => {
		const grouped = new Map<string, SidebarProject[]>();
		for (const project of projects) {
			const items = grouped.get(project.envId);
			if (items) items.push(project);
			else grouped.set(project.envId, [project]);
		}
		return grouped;
	}, [projects]);

	const sessionsByProject = useMemo(() => {
		const grouped = new Map<string, SidebarSession[]>();
		for (const session of sessions) {
			const items = grouped.get(session.projectId);
			if (items) items.push(session);
			else grouped.set(session.projectId, [session]);
		}
		for (const [projectId, items] of grouped) {
			grouped.set(projectId, sortSidebarSessionsByRecency(items));
		}
		return grouped;
	}, [sessions]);

	const projectNameById = useMemo(
		() => new Map(projects.map((project) => [project.id, project.name])),
		[projects],
	);

	const recentSessions = useMemo(
		() =>
			sortSidebarSessionsActiveFirst(sessions).slice(0, RECENT_SESSION_LIMIT),
		[sessions],
	);

	const close = () => onOpenChange(false);

	const handleSelectSession = (sessionId: string, projectId: string) => {
		onSelectSession(sessionId, projectId);
		close();
	};

	const handleNewChat = (projectId?: string) => {
		onNewChat(projectId);
		close();
	};

	return (
		<DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Overlay className="fixed inset-0 z-[var(--z-dialog-overlay)] bg-black/40 duration-[var(--dur-2)] ease-out data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 motion-reduce:animate-none" />
				<DialogPrimitive.Content
					className={cn(
						// Reserve at least 64px of backdrop for an easy outside-tap dismissal.
						"fixed inset-y-0 left-0 z-[var(--z-dialog)] flex flex-col overflow-hidden pilo-mobile-sidebar",
						"border-r border-sidebar-border/60 bg-sidebar text-sidebar-foreground shadow-popover outline-none",
						"pb-[max(0.5rem,env(safe-area-inset-bottom))] pl-[env(safe-area-inset-left)] pt-[env(safe-area-inset-top)]",
						"[&_button]:touch-manipulation [&_button]:outline-none [&_button:focus-visible]:ring-2 [&_button:focus-visible]:ring-inset [&_button:focus-visible]:ring-sidebar-ring",
						"duration-[var(--dur-2)] ease-out data-[state=open]:animate-in data-[state=open]:slide-in-from-left-full",
						"data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left-full motion-reduce:animate-none",
					)}
				>
					<DialogPrimitive.Title className="sr-only">
						Pilo
					</DialogPrimitive.Title>
					<DialogPrimitive.Description className="sr-only">
						{t("common.sessions")}
					</DialogPrimitive.Description>

					<header className="pilo-mobile-sidebar-header flex shrink-0 items-center pl-5 pr-3">
						<span className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight">
							Pilo
						</span>
						<button
							type="button"
							className={ROW_ACTION_CLASS}
							aria-label={t("sidebar.searchSessions")}
							onClick={() => {
								// 抽屉是 modal，先关闭再叠一层搜索面板，避免两个焦点陷阱打架。
								onOpenChange(false);
								setPaletteOpen(true);
							}}
						>
							<Search className="size-4" aria-hidden="true" />
						</button>
						<DialogPrimitive.Close
							className={ROW_ACTION_CLASS}
							aria-label={t("common.close")}
						>
							<X className="size-4" aria-hidden="true" />
						</DialogPrimitive.Close>
					</header>

					<div className="flex shrink-0 items-center px-(--pilo-mobile-sidebar-content-padding) pb-2">
						<button
							type="button"
							className="pilo-mobile-project-row flex min-w-0 flex-1 items-center gap-2 rounded-md text-left text-sm text-sidebar-foreground transition-colors duration-[var(--dur-1)] ease-[var(--ease)] hover:bg-sidebar-hover active:bg-sidebar-hover motion-reduce:transition-none"
							onClick={() => handleNewChat(activeProjectId ?? undefined)}
						>
							<SquarePen
								className="size-4 shrink-0"
								strokeWidth={1.5}
								aria-hidden="true"
							/>
							<span className="truncate">{t("sidebar.newSession")}</span>
						</button>
					</div>

					<div className="relative mx-(--pilo-mobile-sidebar-content-padding) mb-3 grid shrink-0 grid-cols-2 rounded-(--pilo-segment-radius) bg-sidebar-hover/60 p-(--pilo-segment-padding)">
						<span
							aria-hidden="true"
							className={cn(
								"pointer-events-none absolute inset-y-(--pilo-segment-padding) left-(--pilo-segment-padding) w-[calc(50%-var(--pilo-segment-padding))] rounded-(--pilo-segment-item-radius) bg-sidebar transition-transform duration-[var(--dur-1)] ease-[var(--ease)] motion-reduce:transition-none",
								mode === "recent" && "translate-x-full",
							)}
						/>
						{(
							[
								{ value: "projects", label: t("sidebar.projects") },
								{ value: "recent", label: t("sidebar.recentSessions") },
							] as const
						).map((option) => (
							<button
								key={option.value}
								type="button"
								aria-pressed={mode === option.value}
								className={cn(
									"relative flex min-h-11 min-w-0 items-center justify-center rounded-(--pilo-segment-item-radius) px-2 text-sm font-medium transition-colors duration-[var(--dur-1)] ease-[var(--ease)] motion-reduce:transition-none",
									mode === option.value
										? "text-sidebar-foreground"
										: "text-sidebar-foreground-muted active:text-sidebar-foreground",
								)}
								onClick={() => setMode(option.value)}
							>
								<span className="min-w-0 text-balance leading-4">
									{option.label}
								</span>
							</button>
						))}
					</div>

					<div
						data-mobile-session-scroll=""
						className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-(--pilo-mobile-sidebar-content-padding) pb-4"
					>
						{mode === "recent" ? (
							recentSessions.length === 0 ? (
								<p className="px-3 py-10 text-center text-sm text-sidebar-foreground-muted">
									{t("sidebar.noSessions")}
								</p>
							) : (
								<div className="space-y-(--pilo-mobile-session-gap)">
									{recentSessions.map((session) => (
										<MobileSessionRow
											key={`${session.projectId}:${session.id}`}
											session={session}
											selected={
												activeProjectId === session.projectId &&
												selectedSessionId === session.id
											}
											projectName={projectNameById.get(session.projectId)}
											onRefresh={onRefreshSession}
											onSelect={handleSelectSession}
											confirmingDelete={
												confirmDeleteSessionId ===
												`${session.projectId}:${session.id}`
											}
											onRequestDelete={setConfirmDeleteSessionId}
											onCancelDelete={() => setConfirmDeleteSessionId(null)}
											onConfirmDelete={() => {
												setConfirmDeleteSessionId(null);
												onDeleteSession(session.id, session.projectId);
											}}
										/>
									))}
								</div>
							)
						) : (
							envs.map((env) => {
								const envExpanded = sectionOverrides[`env:${env.id}`] ?? true;
								const envProjects = projectsByEnv.get(env.id) ?? [];
								return (
									<section key={env.id}>
										<MobileEnvRow
											env={env}
											expanded={envExpanded}
											onToggle={() => toggleSection(`env:${env.id}`, true)}
										/>
										{envExpanded ? (
											<div className="space-y-(--pilo-mobile-row-gap)">
												{envProjects.map((project) => {
													const projectExpanded =
														sectionOverrides[`project:${project.id}`] ??
														activeProjectId === project.id;
													const projectSessions =
														sessionsByProject.get(project.id) ?? [];
													const selectedIndex =
														project.id === activeProjectId
															? projectSessions.findIndex(
																	(session) => session.id === selectedSessionId,
																)
															: -1;
													const visibleCount = Math.min(
														projectSessions.length,
														Math.max(
															projectSessionLimits[project.id] ??
																PROJECT_SESSION_BATCH_SIZE,
															Math.ceil(
																(selectedIndex + 1) /
																	PROJECT_SESSION_BATCH_SIZE,
															) * PROJECT_SESSION_BATCH_SIZE,
														),
													);
													return (
														<div key={project.id}>
															<MobileProjectRow
																project={project}
																expanded={projectExpanded}
																selected={activeProjectId === project.id}
																sessionCount={projectSessions.length}
																refreshing={refreshingProjectIds.has(
																	project.id,
																)}
																onToggle={() => {
																	toggleSection(
																		`project:${project.id}`,
																		activeProjectId === project.id,
																	);
																	if (!projectExpanded) {
																		onRefreshProjectSessions(project.id);
																	}
																}}
																onNewChat={handleNewChat}
															/>
															{projectExpanded ? (
																projectSessions.length === 0 ? (
																	<p className="pl-8 pr-2 py-4 text-sm text-sidebar-foreground-muted">
																		{t("sidebar.noSessions")}
																	</p>
																) : (
																	<div className="mt-1 space-y-(--pilo-mobile-session-gap) pb-2">
																		{projectSessions
																			.slice(0, visibleCount)
																			.map((session) => (
																				<MobileSessionRow
																					key={`${session.projectId}:${session.id}`}
																					session={session}
																					selected={
																						activeProjectId ===
																							session.projectId &&
																						selectedSessionId === session.id
																					}
																					confirmingDelete={
																						confirmDeleteSessionId ===
																						`${session.projectId}:${session.id}`
																					}
																					onSelect={handleSelectSession}
																					onRefresh={onRefreshSession}
																					onRequestDelete={
																						setConfirmDeleteSessionId
																					}
																					onCancelDelete={() =>
																						setConfirmDeleteSessionId(null)
																					}
																					onConfirmDelete={() => {
																						setConfirmDeleteSessionId(null);
																						onDeleteSession(
																							session.id,
																							session.projectId,
																						);
																					}}
																				/>
																			))}
																		{projectSessions.length >
																		PROJECT_SESSION_BATCH_SIZE ? (
																			<p
																				className="px-2 text-center text-xs text-sidebar-foreground-muted"
																				aria-live="polite"
																				aria-atomic="true"
																			>
																				{t("common.sessions")} {visibleCount} /{" "}
																				{projectSessions.length}
																			</p>
																		) : null}
																		{visibleCount < projectSessions.length ? (
																			<MobileSessionLoadSentinel
																				onLoadMore={() =>
																					setProjectSessionLimits(
																						(current) => ({
																							...current,
																							[project.id]: Math.max(
																								current[project.id] ?? 0,
																								visibleCount +
																									PROJECT_SESSION_BATCH_SIZE,
																							),
																						}),
																					)
																				}
																			/>
																		) : null}
																	</div>
																)
															) : null}
														</div>
													);
												})}
											</div>
										) : null}
									</section>
								);
							})
						)}
					</div>

					<footer className="mx-(--pilo-mobile-sidebar-content-padding) flex min-h-14 shrink-0 items-center gap-2 border-t border-sidebar-border/60 px-2 pt-1">
						{connectionState === "connected" ? (
							<Wifi
								className="size-4 shrink-0 text-sidebar-foreground-muted"
								strokeWidth={1.5}
								aria-hidden="true"
							/>
						) : (
							<WifiOff
								className="size-4 shrink-0 text-sidebar-foreground-muted"
								strokeWidth={1.5}
								aria-hidden="true"
							/>
						)}
						<span className="min-w-0 flex-1 truncate text-sm text-sidebar-foreground-muted">
							{t(remoteConnectionLabelKey(connectionState))}
						</span>
					</footer>
				</DialogPrimitive.Content>
			</DialogPrimitive.Portal>

			{paletteOpen && client ? (
				<CommandPalette
					client={client}
					open
					onOpenChange={setPaletteOpen}
					projects={projects}
					sessions={sessions}
					onSelectProject={(projectId) => {
						setPaletteOpen(false);
						handleNewChat(projectId);
					}}
					onSelectSession={(target: SessionSearchTarget) => {
						setPaletteOpen(false);
						handleSelectSession(target.sessionId, target.projectId);
					}}
				/>
			) : null}
		</DialogPrimitive.Root>
	);
}
