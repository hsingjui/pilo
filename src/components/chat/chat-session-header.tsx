import {
	ChevronDown,
	MessageSquareDashed,
	PanelLeft,
	PanelRight,
	TerminalSquare,
} from "lucide-react";

import {
	IS_MACOS,
	TRAFFIC_LIGHT_ALIGNED_HEADER,
	TRAFFIC_LIGHT_GUTTER,
} from "@/components/title-bar";
import { cn } from "@/lib/utils";
import type { Project } from "@/lib/projects";
import { Button, Tooltip, TooltipContent, TooltipTrigger } from "@/ui";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/ui";
import type { ChatSession, ChatSessionRuntimeState } from "./chat-page-utils";

export function SessionHeader({
	session,
	sessionState,
	project,
	projects,
	onSwitchProject,
	onOpenChanges,
	onOpenTerminal,
	terminalRunning = false,
	terminalVisible = false,
	onNewTemporaryChat,
	onExpandSidebar,
	reserveWindowControls = false,
	sidebarCollapsed = false,
	overlay = false,
}: {
	session?: ChatSession;
	sessionState?: ChatSessionRuntimeState;
	/** 落地页（新会话）模式：当前落点项目。 */
	project?: Project | null;
	/** 落地页（新会话）模式：可切换的项目列表。 */
	projects?: Project[];
	onSwitchProject?: (projectId: string) => void;
	onOpenChanges?: () => void;
	onOpenTerminal?: () => void;
	terminalRunning?: boolean;
	terminalVisible?: boolean;
	onNewTemporaryChat?: () => void;
	onExpandSidebar?: () => void;
	reserveWindowControls?: boolean;
	sidebarCollapsed?: boolean;
	overlay?: boolean;
}) {
	return (
		<header
			data-tauri-drag-region="deep"
			className={cn(
				"flex h-11 shrink-0 items-center bg-background",
				IS_MACOS ? TRAFFIC_LIGHT_ALIGNED_HEADER : "mt-0.5",
				overlay ? "absolute inset-x-0 top-0 z-30" : "relative",
				IS_MACOS && sidebarCollapsed && TRAFFIC_LIGHT_GUTTER,
				reserveWindowControls && "pr-[7.75rem]",
			)}
		>
			{/* 展开按钮悬浮在标题左侧 logo 位（不占布局，标题在侧栏开合全程不位移），
			    折叠完成后（延迟 200ms 与侧栏收起过渡对齐）淡入；macOS 收起时避让交通灯 */}
			<div
				aria-hidden={!sidebarCollapsed}
				className={cn(
					"absolute top-1/2 z-10 -translate-y-1/2 transition-opacity duration-200 ease-out motion-reduce:transition-none",
					IS_MACOS && sidebarCollapsed ? "left-[4.875rem]" : "left-1.5",
					sidebarCollapsed
						? "opacity-100 delay-200"
						: "pointer-events-none opacity-0",
				)}
			>
				<Button
					variant="ghost"
					size="icon"
					className="size-7 shrink-0 text-muted-foreground"
					aria-label="展开侧边栏"
					tabIndex={sidebarCollapsed ? 0 : -1}
					onClick={onExpandSidebar}
				>
					<PanelLeft className="size-4" />
				</Button>
			</div>
			{session && !session.temporary ? (
				<div
					role="tablist"
					aria-label="会话"
					className="flex min-w-0 flex-1 items-center px-1"
				>
					<div
						role="tab"
						aria-selected="true"
						tabIndex={0}
						className="group flex h-8 w-fit max-w-[66.666667%] min-w-0 items-center gap-1.5 overflow-hidden rounded-md border border-transparent px-3 text-sm text-foreground outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
					>
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
						<span className="min-w-0 flex-1 truncate">
							{sessionState?.name || session.title}
						</span>
					</div>
				</div>
			) : projects && projects.length > 0 ? (
				/* 落地页没有会话：用项目下拉占据会话 tab 的同一位置，
				   让用户看到并切换新会话的落点项目 */
				<div
					role="tablist"
					aria-label="会话"
					className="flex min-w-0 flex-1 items-center px-1"
				>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<button
								type="button"
								className="group flex h-8 w-fit max-w-[66.666667%] min-w-0 items-center gap-1.5 overflow-hidden rounded-md border border-transparent px-3 text-sm text-foreground outline-hidden transition-colors hover:bg-muted/40 focus-visible:ring-1 focus-visible:ring-ring"
							>
								<span
									aria-hidden="true"
									className={cn(
										"size-2.5 shrink-0 rounded-[4px] bg-muted-foreground/50",
										sidebarCollapsed && "opacity-0",
									)}
								/>
								<span className="min-w-0 flex-1 truncate text-left">
									{project ? project.name : "选择项目"}
								</span>
								<ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
							</button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start" className="min-w-48">
							{projects.map((candidate) => (
								<DropdownMenuItem
									key={candidate.id}
									onClick={() => onSwitchProject?.(candidate.id)}
								>
									<span className="min-w-0 flex-1 truncate">
										{candidate.name}
									</span>
									{project?.id === candidate.id ? (
										<span className="shrink-0 text-muted-foreground text-xs">
											当前
										</span>
									) : null}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			) : (
				/* 没有会话也没有项目：占位保证顶栏几何一致 */
				<div className="min-w-0 flex-1" />
			)}
			{onNewTemporaryChat || onOpenChanges || onOpenTerminal ? (
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
									aria-label={terminalVisible ? "隐藏终端" : "显示终端"}
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
								{terminalVisible ? "隐藏终端" : "显示终端"}
							</TooltipContent>
						</Tooltip>
					) : null}
					{onNewTemporaryChat ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="ghost"
									size="icon"
									className="size-7"
									aria-label="打开临时会话"
									onClick={onNewTemporaryChat}
								>
									<MessageSquareDashed className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>临时会话</TooltipContent>
						</Tooltip>
					) : null}
					{onOpenChanges ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="ghost"
									size="icon"
									className="size-7"
									aria-label="显示变更"
									onClick={onOpenChanges}
								>
									<PanelRight className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>显示变更</TooltipContent>
						</Tooltip>
					) : null}
				</div>
			) : null}
		</header>
	);
}
