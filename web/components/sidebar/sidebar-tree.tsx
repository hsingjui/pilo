import { lazy, Suspense, useCallback, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { ScrollArea } from "@/ui";
import { EnvRow } from "./env-row";
import { ProjectRow } from "./project-row";
import { RecentSectionHeader } from "./recent-section-header";
import { SessionRow, SessionRowGlide } from "./session-row";
import { summarizeProjectSessions } from "@shared/sidebar/session-list";
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
	onSelectSession: (sessionId: string, projectId: string) => void;
	onRenameSession: (
		sessionId: string,
		title: string,
		projectId: string,
	) => void;
	onDeleteSession: (sessionId: string, projectId: string) => void;
	onRefreshSession?: (sessionId: string, projectId: string) => Promise<void>;
};

/**
 * Sidebar scroll body: recent-session view or the per-connection project tree.
 */
export function SidebarTree({
	scrollViewportRef,
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
	onSelectSession,
	onRenameSession,
	onDeleteSession,
	onRefreshSession,
}: SidebarTreeProps) {
	const { t } = useTranslation();

	const renderSession = useCallback(
		(session: SidebarSession) => {
			// 「展示项目」开启且处于“最近会话”视图时才带项目名（两行式）；
			// 项目树视图下会话已归属项目节点，不重复展示项目名。
			const showProjectName =
				organizeMode === "recent" && showProjectsInRecents;
			return (
				<SessionRow
					key={`${session.projectId}:${session.id}`}
					session={session}
					selected={
						activeSessionId === session.id &&
						(!selectedProjectId || selectedProjectId === session.projectId)
					}
					onSelect={onSelectSession}
					onDelete={onDeleteSession}
					onRename={onRenameSession}
					onRefresh={onRefreshSession}
					projectName={
						showProjectName ? projectById.get(session.projectId) : undefined
					}
				/>
			);
		},
		[
			activeSessionId,
			selectedProjectId,
			organizeMode,
			showProjectsInRecents,
			projectById,
			onDeleteSession,
			onRenameSession,
			onRefreshSession,
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
				fallback={
					<SessionRowGlide>
						{projectSessions.slice(0, 40).map(renderSession)}
					</SessionRowGlide>
				}
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
				{organizeMode === "recent" ? (
					<section className="mb-3 w-full min-w-0 space-y-(--pilo-sidebar-row-gap) overflow-hidden last:mb-0">
						<RecentSectionHeader
							collapsed={collapsedSections["recent"] ?? false}
							onToggle={() => onToggleSection("recent")}
							view={organizeMode}
							onViewChange={onOrganizeModeChange}
							showProjects={showProjectsInRecents}
							onShowProjectsChange={onShowProjectsInRecentsChange}
						/>
						{recentSessions.length > 0 ? (
							!(collapsedSections["recent"] ?? false) ? (
								renderSessionList(recentSessions)
							) : null
						) : (
							<div className="px-3 py-8 text-center text-xs text-sidebar-foreground-muted">
								{t("sidebar.noSessions")}
							</div>
						)}
					</section>
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
								className="mb-3 w-full min-w-0 space-y-(--pilo-sidebar-row-gap) overflow-hidden last:mb-0"
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
								{!envCollapsed
									? envProjects.map((project) => {
											const projectCollapsed =
												collapsedSections[`ws:${project.id}`] ?? true;
											const projectSessions =
												sessionsByProject.get(project.id) ?? [];
											const projectSessionSummary = projectCollapsed
												? null
												: summarizeProjectSessions(
														projectSessions,
														selectedProjectId === project.id
															? activeSessionId
															: null,
													);
											return (
												<div
													key={project.id}
													className="relative grid w-full min-w-0 gap-px overflow-visible rounded-md"
												>
													<ProjectRow
														project={project}
														env={env}
														collapsed={projectCollapsed}
														selected={
															activeSessionId === null &&
															selectedProjectId === project.id
														}
														refreshing={refreshingProjectIds.has(project.id)}
														onSelect={() => {
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
																? () => onRefreshProjectSessions(project.id)
																: undefined
														}
													/>
													{projectSessionSummary ? (
														<SessionRowGlide>
															{projectSessionSummary.visible.map(renderSession)}
															{projectSessionSummary.hiddenCount > 0 ? (
																<button
																	type="button"
																	data-session-row=""
																	className="relative flex w-full items-center gap-1.5 rounded-md border border-transparent bg-transparent px-2 py-1 text-left text-xs text-sidebar-foreground-muted transition-colors hover:bg-sidebar-hover group-hover/glide:hover:bg-transparent hover:text-sidebar-hover-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sidebar-ring"
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
														</SessionRowGlide>
													) : null}
												</div>
											);
										})
									: null}
							</section>
						);
					})
				)}
			</div>
		</ScrollArea>
	);
}
