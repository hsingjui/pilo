import { lazy, Suspense, useCallback, useRef, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import {
	closestCenter,
	DndContext,
	PointerSensor,
	type DragEndEvent,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	arrayMove,
	SortableContext,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { ScrollArea } from "@/ui";
import { EnvRow } from "./env-row";
import { ProjectRow } from "./project-row";
import { RecentSectionHeader } from "./recent-section-header";
import { SessionRow, SessionRowGlide } from "./session-row";
import { SidebarSkeleton } from "./sidebar-skeleton";
import { SortableProjectBlock } from "./sortable-project-block";
import { summarizeProjectSessions } from "./session-list";
import type {
	SidebarEnv,
	SidebarEnvView,
	SidebarProject,
	SidebarSession,
} from "./types";

const VirtualSessionRows = lazy(() =>
	import("./virtual-session-rows").then((module) => ({
		default: module.VirtualSessionRows,
	})),
);

type SidebarTreeProps = {
	scrollViewportRef: RefObject<HTMLDivElement | null>;
	refreshing: boolean;
	organizeMode: SidebarEnvView;
	onOrganizeModeChange: (mode: SidebarEnvView) => void;
	collapsedSections: Record<string, boolean>;
	onToggleSection: (key: string, defaultCollapsed?: boolean) => void;
	showProjectsInRecents: boolean;
	onShowProjectsInRecentsChange: (value: boolean) => void;
	recentSessions: SidebarSession[];
	projectSessionsViewProject: SidebarProject | null;
	projectSessionsViewSessions: SidebarSession[];
	onOpenProjectSessionsView: (projectId: string) => void;
	projectById: Map<string, string>;
	activeSessionId: string | null;
	selectedProjectId?: string | null;
	envs: SidebarEnv[];
	projectsByEnv: Map<string, SidebarProject[]>;
	sessionsByProject: Map<string, SidebarSession[]>;
	refreshingProjectIds: ReadonlySet<string>;
	onFocusProject?: (projectId: string) => void;
	onNewChatInProject?: (projectId: string) => void;
	onDeleteProject?: (projectId: string) => void;
	onAddProject?: (connectionId?: string) => void;
	onDeleteConnection?: (connectionId: string) => void;
	onRefreshProjectSessions?: (projectId: string) => void;
	onReorderProjects?: (connectionId: string, projectIds: string[]) => void;
	onSelectSession: (sessionId: string) => void;
	onRenameSession: (sessionId: string, title: string) => void;
	onDeleteSession: (sessionId: string) => void;
};

/**
 * Sidebar scroll body: recent-session view or the per-connection project tree.
 * Keeps the DnD wiring and virtualized session rendering out of the shell.
 */
export function SidebarTree({
	scrollViewportRef,
	refreshing,
	organizeMode,
	onOrganizeModeChange,
	collapsedSections,
	onToggleSection,
	showProjectsInRecents,
	onShowProjectsInRecentsChange,
	recentSessions,
	projectSessionsViewProject,
	projectSessionsViewSessions,
	onOpenProjectSessionsView,
	projectById,
	activeSessionId,
	selectedProjectId,
	envs,
	projectsByEnv,
	sessionsByProject,
	refreshingProjectIds,
	onFocusProject,
	onNewChatInProject,
	onDeleteProject,
	onAddProject,
	onDeleteConnection,
	onRefreshProjectSessions,
	onReorderProjects,
	onSelectSession,
	onRenameSession,
	onDeleteSession,
}: SidebarTreeProps) {
	const { t } = useTranslation();
	const suppressProjectClickRef = useRef(false);
	const projectDragSensors = useSensors(
		useSensor(PointerSensor, {
			activationConstraint: { distance: 6 },
		}),
	);

	const handleProjectDragEnd = useCallback(
		(envId: string, event: DragEndEvent) => {
			const { active, over } = event;
			if (!over || active.id === over.id) return;
			const order = (projectsByEnv.get(envId) ?? []).map(
				(project) => project.id,
			);
			const fromIndex = order.indexOf(String(active.id));
			const toIndex = order.indexOf(String(over.id));
			if (fromIndex < 0 || toIndex < 0) return;
			onReorderProjects?.(envId, arrayMove(order, fromIndex, toIndex));
		},
		[onReorderProjects, projectsByEnv],
	);

	const renderSession = useCallback(
		(session: SidebarSession) => {
			// 「展示项目」开启且处于“最近会话”视图时才带项目名（两行式）；
			// 项目树视图下会话已归属项目节点，不重复展示项目名。
			const showProjectName =
				organizeMode === "recent" && showProjectsInRecents;
			return (
				<SessionRow
					key={session.id}
					session={session}
					selected={activeSessionId === session.id}
					onSelect={onSelectSession}
					onDelete={session.sessionPath ? onDeleteSession : undefined}
					onRename={onRenameSession}
					projectName={
						showProjectName ? projectById.get(session.projectId) : undefined
					}
				/>
			);
		},
		[
			activeSessionId,
			organizeMode,
			showProjectsInRecents,
			projectById,
			onDeleteSession,
			onRenameSession,
			onSelectSession,
		],
	);

	const renderSessionList = (projectSessions: SidebarSession[]) => {
		if (projectSessions.length < 40) {
			return (
				<SessionRowGlide>{projectSessions.map(renderSession)}</SessionRowGlide>
			);
		}

		return (
			<Suspense
				fallback={<>{projectSessions.slice(0, 40).map(renderSession)}</>}
			>
				<VirtualSessionRows
					sessions={projectSessions}
					scrollViewportRef={scrollViewportRef}
					renderSession={renderSession}
				/>
			</Suspense>
		);
	};

	return (
		<ScrollArea
			className="mt-2 min-h-0 min-w-0 flex-1 overflow-x-hidden"
			viewportRef={scrollViewportRef}
			viewportClassName="min-w-0 overflow-x-hidden overscroll-y-none pl-1.5 pr-2.5 pb-3"
			scrollbarClassName="w-2 p-px"
			scrollbarThumbClassName="bg-[hsl(var(--muted-foreground)/0.35)] hover:bg-[hsl(var(--muted-foreground)/0.45)] active:bg-[hsl(var(--muted-foreground)/0.55)]"
		>
			<div className="relative w-full min-w-0 overflow-x-hidden pt-1">
				{refreshing ? (
					<SidebarSkeleton />
				) : organizeMode === "recent" ? (
					recentSessions.length > 0 ? (
						<section className="mb-3 w-full min-w-0 space-y-0.5 overflow-hidden last:mb-0">
							<RecentSectionHeader
								collapsed={collapsedSections["recent"] ?? false}
								onToggle={() => onToggleSection("recent")}
								view={organizeMode}
								onViewChange={onOrganizeModeChange}
								showProjects={showProjectsInRecents}
								onShowProjectsChange={onShowProjectsInRecentsChange}
							/>
							{!(collapsedSections["recent"] ?? false)
								? renderSessionList(recentSessions)
								: null}
						</section>
					) : (
						<div className="px-3 py-8 text-center text-xs text-sidebar-foreground-muted">
							{t("sidebar.noSessions")}
						</div>
					)
				) : projectSessionsViewProject ? (
					projectSessionsViewSessions.length > 0 ? (
						renderSessionList(projectSessionsViewSessions)
					) : (
						<div className="px-3 py-8 text-center text-xs text-sidebar-foreground-muted">
							{t("sidebar.noSessions")}
						</div>
					)
				) : (
					envs.map((env) => {
						const envCollapsed = collapsedSections[`env:${env.id}`] ?? false;
						const envProjects = projectsByEnv.get(env.id) ?? [];
						return (
							<section
								key={env.id}
								className="mb-3 w-full min-w-0 space-y-0.5 overflow-hidden last:mb-0"
							>
								<EnvRow
									env={env}
									collapsed={envCollapsed}
									onToggle={() => onToggleSection(`env:${env.id}`)}
									view={organizeMode}
									onViewChange={onOrganizeModeChange}
									showProjects={showProjectsInRecents}
									onShowProjectsChange={onShowProjectsInRecentsChange}
									onAddProject={onAddProject}
									onDeleteConnection={onDeleteConnection}
								/>
								{!envCollapsed ? (
									<>
										<DndContext
											sensors={projectDragSensors}
											collisionDetection={closestCenter}
											onDragStart={() => {
												suppressProjectClickRef.current = true;
											}}
											onDragCancel={() => {
												window.setTimeout(() => {
													suppressProjectClickRef.current = false;
												}, 0);
											}}
											onDragEnd={(event) => {
												handleProjectDragEnd(env.id, event);
												window.setTimeout(() => {
													suppressProjectClickRef.current = false;
												}, 0);
											}}
										>
											<SortableContext
												items={envProjects.map((project) => project.id)}
												strategy={verticalListSortingStrategy}
											>
												{envProjects.map((project) => {
													const projectCollapsed =
														collapsedSections[`ws:${project.id}`] ?? true;
													const projectSessions =
														sessionsByProject.get(project.id) ?? [];
													const projectSessionSummary = projectCollapsed
														? null
														: summarizeProjectSessions(
																projectSessions,
																activeSessionId,
															);
													return (
														<SortableProjectBlock
															key={project.id}
															id={project.id}
															disabled={
																refreshingProjectIds.has(project.id) ||
																envProjects.length < 2
															}
															row={
																<ProjectRow
																	project={project}
																	env={env}
																	collapsed={projectCollapsed}
																	selected={
																		activeSessionId === null &&
																		selectedProjectId === project.id
																	}
																	refreshing={refreshingProjectIds.has(
																		project.id,
																	)}
																	onSelect={() => {
																		if (suppressProjectClickRef.current) return;
																		onFocusProject?.(project.id);
																		onNewChatInProject?.(project.id);
																	}}
																	onToggle={() => {
																		const key = `ws:${project.id}`;
																		onToggleSection(key, true);
																		if (projectCollapsed)
																			onRefreshProjectSessions?.(project.id);
																	}}
																	onNewChat={onNewChatInProject}
																	onDelete={onDeleteProject}
																	onRefreshSessions={
																		onRefreshProjectSessions
																			? () =>
																					onRefreshProjectSessions(project.id)
																			: undefined
																	}
																/>
															}
														>
															{projectSessionSummary ? (
																<>
																	<SessionRowGlide>
																		{projectSessionSummary.visible.map(
																			renderSession,
																		)}
																	</SessionRowGlide>
																	{projectSessionSummary.hiddenCount > 0 ? (
																		<button
																			type="button"
																			className="flex w-full items-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-left text-xs text-sidebar-foreground-muted transition-colors hover:bg-sidebar-hover hover:text-sidebar-hover-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sidebar-ring"
																			onClick={() =>
																				onOpenProjectSessionsView(project.id)
																			}
																		>
																			<span
																				aria-hidden="true"
																				className="h-4 w-4 shrink-0"
																			/>
																			<span className="min-w-0 flex-1 truncate">
																				{t("sidebar.viewAll")}
																			</span>
																		</button>
																	) : null}
																</>
															) : null}
														</SortableProjectBlock>
													);
												})}
											</SortableContext>
										</DndContext>
									</>
								) : null}
							</section>
						);
					})
				)}
			</div>
		</ScrollArea>
	);
}
