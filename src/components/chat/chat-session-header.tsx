import { useContext } from "react";
import { ProjectWorkspaceContext } from "@/components/app/project-workspace-context";
import {
	MessageSquareDashed,
	PanelLeft,
	GitBranch,
	SquarePen,
	TerminalSquare,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { isTauri } from "@tauri-apps/api/core";

import {
	CUSTOM_TITLEBAR,
	IS_MACOS,
	TRAFFIC_LIGHT_ALIGNED_HEADER,
	TRAFFIC_LIGHT_GUTTER,
} from "@/components/title-bar";
import { ProjectWorkspaceTabs } from "@/components/app/project-workspace-tabs";
import { ProjectEditorMenu } from "@/components/project-editor-menu";
import type { Project } from "@/lib/api/projects";
import { cn } from "@/lib/utils";
import { isSessionWindow } from "@/lib/api/window";
import { Button, Tooltip, TooltipContent, TooltipTrigger } from "@/ui";
import type { ChatSession, ChatSessionRuntimeState } from "./chat-page-utils";
import { SessionHeaderMenu } from "./chat-session-header-menu";

export function SessionHeader({
	session,
	project = session?.projectRecord,
	sessionState,
	onOpenTerminal,
	terminalRunning = false,
	terminalVisible = false,
	onNewTemporaryChat,
	onNewChat,
	onExpandSidebar,
	onRenameSession,
	onFindInSession,
	onOpenInNewWindow,
	reserveWindowControls = false,
	sidebarCollapsed = false,
	overlay = false,
	temporary = false,
}: {
	session?: ChatSession;
	project?: Project | null;
	sessionState?: ChatSessionRuntimeState;
	onOpenTerminal?: () => void;
	terminalRunning?: boolean;
	terminalVisible?: boolean;
	onNewTemporaryChat?: () => void;
	/** 移动端顶栏的「新对话」入口；桌面端不传，保持侧栏新建语义。 */
	onNewChat?: () => void;
	onExpandSidebar?: () => void;
	onRenameSession?: (title: string) => void;
	onFindInSession?: () => void;
	onOpenInNewWindow?: () => void;
	reserveWindowControls?: boolean;
	sidebarCollapsed?: boolean;
	overlay?: boolean;
	/** 落地页无 session 时，用临时会话草稿态显示临时标识。 */
	temporary?: boolean;
}) {
	const { t } = useTranslation();
	const editorProject = isTauri() ? project : null;
	const workspace = useContext(ProjectWorkspaceContext);
	const activeTab = project
		? workspace?.state.get(project.id)?.activeTab
		: undefined;
	const activeFilePath =
		activeTab?.kind === "file" ? activeTab.path : undefined;
	const workspaceActive = Boolean(activeTab && activeTab.kind !== "chat");
	// 会话窗口的 TitleBar 额外渲染置顶按钮（见 App.tsx 的 showAlwaysOnTop），
	// 需要按多一个控件宽度避让，否则会压住菜单按钮。
	const reserveWithPin =
		reserveWindowControls && CUSTOM_TITLEBAR && isSessionWindow();
	const temporaryActive = Boolean(session?.temporary || temporary);
	return (
		<header
			data-tauri-drag-region="deep"
			className={cn(
				"flex h-11 shrink-0 items-center bg-background",
				IS_MACOS ? TRAFFIC_LIGHT_ALIGNED_HEADER : "mt-0.5",
				overlay ? "absolute inset-x-0 top-0 z-30" : "relative",
				workspaceActive && "z-40",
				IS_MACOS && sidebarCollapsed && TRAFFIC_LIGHT_GUTTER,
				reserveWindowControls &&
					(reserveWithPin ? "pr-[10.25rem]" : "pr-[7.75rem]"),
			)}
		>
			{/* 展开按钮悬浮在标题左侧 logo 位（不占布局，标题在侧栏开合全程不位移），
			    折叠完成后（延迟 200ms 与侧栏收起过渡对齐）淡入；macOS 收起时避让交通灯 */}
			<div
				aria-hidden={!sidebarCollapsed}
				className={cn(
					"absolute top-1/2 z-10 -translate-y-1/2 transition-opacity duration-200 ease-out motion-reduce:transition-none",
					// macOS 全程停在红绿灯右侧：展开时该按钮虽在淡出，若切回 left-1.5 会
					// 正好压在红绿灯下方。
					IS_MACOS ? "left-[4.875rem]" : "left-1.5",
					sidebarCollapsed
						? "opacity-100 delay-200"
						: "pointer-events-none opacity-0",
				)}
			>
				<Button
					variant="ghost"
					size="icon"
					className="size-7 shrink-0 text-muted-foreground"
					aria-label={t("navigation.expandSidebar")}
					tabIndex={sidebarCollapsed ? 0 : -1}
					onClick={onExpandSidebar}
				>
					<PanelLeft className="size-4" />
				</Button>
			</div>
			<ProjectWorkspaceTabs
				projectId={project?.id}
				title={
					session || temporaryActive
						? sessionState?.name ||
							session?.title ||
							(temporaryActive ? t("app.temporaryChat") : t("app.newChat"))
						: undefined
				}
				temporary={temporaryActive}
			>
				{temporaryActive ? (
					<MessageSquareDashed aria-hidden="true" className="size-4 shrink-0" />
				) : (
					<svg
						viewBox="0 0 800 800"
						className={cn(
							"size-[1.15em] shrink-0 text-muted-foreground transition-opacity duration-200 motion-reduce:transition-none",
							// 折叠时淡出，避免与悬浮的展开图标叠在一起
							sidebarCollapsed ? "opacity-0" : "opacity-60",
						)}
						aria-hidden="true"
					>
						<path
							className="fill-current"
							fillRule="evenodd"
							d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
						/>
						<path
							className="fill-current"
							d="M517.36 400H634.72V634.72H517.36Z"
						/>
					</svg>
				)}
			</ProjectWorkspaceTabs>
			{editorProject ||
			onNewTemporaryChat ||
			onNewChat ||
			onOpenTerminal ||
			(session && !session.temporary) ? (
				<div
					className={cn(
						"flex shrink-0 items-center gap-1 pr-2",
						reserveWindowControls && "-translate-y-1",
					)}
				>
					{onOpenTerminal ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="ghost"
									size="icon"
									className="size-7"
									aria-pressed={terminalVisible}
									aria-label={
										terminalVisible ? t("terminal.hide") : t("terminal.show")
									}
									onClick={onOpenTerminal}
								>
									<TerminalSquare
										className={cn(
											"size-4 transition-colors",
											terminalRunning && "text-primary",
										)}
									/>
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{terminalVisible ? t("terminal.hide") : t("terminal.show")}
							</TooltipContent>
						</Tooltip>
					) : null}
					{onNewChat ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="ghost"
									size="icon"
									className="size-7"
									aria-label={t("app.newChat")}
									onClick={onNewChat}
								>
									<SquarePen className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>{t("app.newChat")}</TooltipContent>
						</Tooltip>
					) : null}
					{onNewTemporaryChat ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="ghost"
									size="icon"
									className="size-7"
									aria-label={t("app.temporaryChat")}
									aria-pressed={temporaryActive}
									onClick={onNewTemporaryChat}
								>
									<MessageSquareDashed
										className={cn(
											"size-4 transition-colors",
											temporaryActive && "text-primary",
										)}
									/>
								</Button>
							</TooltipTrigger>
							<TooltipContent>{t("app.temporaryChat")}</TooltipContent>
						</Tooltip>
					) : null}
					{editorProject ? (
						<ProjectEditorMenu
							project={editorProject}
							filePath={activeFilePath ?? undefined}
						/>
					) : null}
					{editorProject && workspace ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="ghost"
									size="icon"
									className="size-7 [@media(pointer:coarse)]:size-11"
									data-open-git=""
									aria-label={t("file.viewChanges")}
									aria-pressed={activeTab?.kind === "git"}
									onClick={() => workspace.openGit(editorProject.id)}
								>
									<GitBranch aria-hidden="true" className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>{t("file.viewChanges")}</TooltipContent>
						</Tooltip>
					) : null}
					{session && !session.temporary ? (
						<SessionHeaderMenu
							session={session}
							sessionState={sessionState}
							onRenameSession={onRenameSession}
							onFindInSession={
								onFindInSession
									? () => {
											if (project) workspace?.selectFile(project.id, null);
											onFindInSession();
										}
									: undefined
							}
							onOpenInNewWindow={onOpenInNewWindow}
						/>
					) : null}
				</div>
			) : null}
		</header>
	);
}
