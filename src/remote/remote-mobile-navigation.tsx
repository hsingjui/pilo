import { useMemo, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import {
	Clock,
	Folder,
	RefreshCw,
	Search,
	SquarePen,
	Wifi,
	WifiOff,
	X,
} from "lucide-react";

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
import type { PiloClient } from "@/lib/pilo-client";
import { cn } from "@/lib/utils";
import {
	MobileEnvRow,
	MobileProjectRow,
	MobileSessionRow,
	ROW_ACTION_CLASS,
} from "@/remote/remote-mobile-rows";

/** “最近会话”视图最多展示的会话数，与桌面侧栏保持一致。 */
const RECENT_SESSION_LIMIT = 50;

export function RemoteMobileNavigation({
	client,
	open,
	onOpenChange,
	envs,
	projects,
	sessions,
	activeProjectId,
	selectedSessionId,
	connected,
	refreshingProjectIds,
	refreshing,
	onSelectSession,
	onNewChat,
	onRefreshProjectSessions,
	onRefresh,
	onReload,
	onDeleteSession,
}: {
	client: PiloClient | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	envs: SidebarEnv[];
	projects: SidebarProject[];
	sessions: SidebarSession[];
	activeProjectId: string | null;
	selectedSessionId: string | null;
	connected: boolean;
	refreshingProjectIds: ReadonlySet<string>;
	refreshing: boolean;
	onSelectSession: (sessionId: string) => void;
	onNewChat: (projectId?: string) => void;
	onRefreshProjectSessions: (projectId: string) => void;
	onRefresh: () => void;
	onReload: () => void;
	onDeleteSession: (sessionId: string) => void;
}) {
	const { t } = useTranslation();
	const [mode, setMode] = useState<SidebarEnvView>("projects");
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [confirmDeleteSessionId, setConfirmDeleteSessionId] = useState<
		string | null
	>(null);
	// 未出现的 key 走默认值：连接展开、项目折叠（当前项目例外）。
	const [sectionOverrides, setSectionOverrides] = useState<
		Record<string, boolean>
	>({});

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

	const handleSelectSession = (sessionId: string) => {
		onSelectSession(sessionId);
		close();
	};

	const handleNewChat = (projectId?: string) => {
		onNewChat(projectId);
		close();
	};

	return (
		<DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Overlay className="fixed inset-0 z-[var(--z-dialog-overlay)] bg-black/40 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
				<DialogPrimitive.Content
					className={cn(
						// 固定宽度：移动端不提供拖拽调宽，也不必复用桌面侧栏的宽度状态。
						"fixed inset-y-0 left-0 z-[var(--z-dialog)] flex w-[min(86vw,20rem)] flex-col",
						"border-r border-sidebar-border bg-sidebar text-sidebar-foreground shadow-popover outline-none",
						"pb-[max(0.25rem,env(safe-area-inset-bottom))] pl-[env(safe-area-inset-left)] pt-[env(safe-area-inset-top)]",
						"data-[state=open]:animate-in data-[state=open]:slide-in-from-left-4",
						"data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left-4",
					)}
				>
					<DialogPrimitive.Title className="sr-only">
						Pilo
					</DialogPrimitive.Title>
					<DialogPrimitive.Description className="sr-only">
						{t("common.sessions")}
					</DialogPrimitive.Description>

					<header className="flex h-14 shrink-0 items-center gap-1 px-3">
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
							<Search className="size-4" />
						</button>
						<DialogPrimitive.Close
							className={ROW_ACTION_CLASS}
							aria-label={t("common.close")}
						>
							<X className="size-4" />
						</DialogPrimitive.Close>
					</header>

					<div className="flex shrink-0 items-center gap-1 px-3 pb-2">
						<button
							type="button"
							className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-3 text-left text-sm active:bg-sidebar-hover"
							onClick={() => handleNewChat(activeProjectId ?? undefined)}
						>
							<SquarePen className="size-4 shrink-0" />
							<span className="truncate">{t("sidebar.newSession")}</span>
						</button>
						<button
							type="button"
							className={cn(ROW_ACTION_CLASS, "disabled:opacity-50")}
							aria-label={t("sidebar.refreshSidebar")}
							disabled={refreshing}
							onClick={onRefresh}
						>
							<RefreshCw
								className={cn("size-4", refreshing && "animate-spin")}
							/>
						</button>
					</div>

					<div className="mx-3 mb-2 grid shrink-0 grid-cols-2 gap-1 rounded-lg bg-sidebar-hover/60 p-1">
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
									"flex min-h-9 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors",
									mode === option.value
										? "bg-sidebar text-sidebar-foreground shadow-sm"
										: "text-sidebar-foreground-muted",
								)}
								onClick={() => setMode(option.value)}
							>
								{option.value === "projects" ? (
									<Folder className="size-3.5 shrink-0" aria-hidden="true" />
								) : (
									<Clock className="size-3.5 shrink-0" aria-hidden="true" />
								)}
								<span className="min-w-0 truncate">{option.label}</span>
							</button>
						))}
					</div>

					<div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain px-2 pb-3">
						{mode === "recent" ? (
							recentSessions.length === 0 ? (
								<p className="px-3 py-10 text-center text-sm text-sidebar-foreground-muted">
									{t("sidebar.noSessions")}
								</p>
							) : (
								<div className="space-y-0.5">
									{recentSessions.map((session) => (
										<MobileSessionRow
											key={session.id}
											session={session}
											selected={selectedSessionId === session.id}
											projectName={projectNameById.get(session.projectId)}
											onSelect={handleSelectSession}
											confirmingDelete={confirmDeleteSessionId === session.id}
											onRequestDelete={setConfirmDeleteSessionId}
											onCancelDelete={() => setConfirmDeleteSessionId(null)}
											onConfirmDelete={() => {
												setConfirmDeleteSessionId(null);
												onDeleteSession(session.id);
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
											<div className="space-y-0.5">
												{envProjects.map((project) => {
													const projectExpanded =
														sectionOverrides[`project:${project.id}`] ??
														activeProjectId === project.id;
													const projectSessions =
														sessionsByProject.get(project.id) ?? [];
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
																	<p className="px-3 py-3 text-xs text-sidebar-foreground-muted">
																		{t("sidebar.noSessions")}
																	</p>
																) : (
																	<div className="mt-0.5 space-y-0.5 pb-1">
																		{projectSessions.map((session) => (
																			<MobileSessionRow
																				key={session.id}
																				session={session}
																				selected={
																					selectedSessionId === session.id
																				}
																				confirmingDelete={
																					confirmDeleteSessionId === session.id
																				}
																				onSelect={handleSelectSession}
																				onRequestDelete={
																					setConfirmDeleteSessionId
																				}
																				onCancelDelete={() =>
																					setConfirmDeleteSessionId(null)
																				}
																				onConfirmDelete={() => {
																					setConfirmDeleteSessionId(null);
																					onDeleteSession(session.id);
																				}}
																			/>
																		))}
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

					<footer className="flex min-h-12 shrink-0 items-center gap-2 border-t border-sidebar-border px-3">
						{connected ? (
							<Wifi
								className="size-4 shrink-0 text-sidebar-foreground-muted"
								aria-hidden="true"
							/>
						) : (
							<WifiOff
								className="size-4 shrink-0 text-sidebar-foreground-muted"
								aria-hidden="true"
							/>
						)}
						<span className="min-w-0 flex-1 truncate text-xs text-sidebar-foreground-muted">
							{connected
								? t("settings.remoteConnected")
								: t("settings.remoteReconnecting")}
						</span>
						<button
							type="button"
							className={ROW_ACTION_CLASS}
							aria-label={t("app.reload")}
							onClick={onReload}
						>
							<RefreshCw className="size-4" />
						</button>
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
						handleSelectSession(target.sessionId);
					}}
				/>
			) : null}
		</DialogPrimitive.Root>
	);
}
