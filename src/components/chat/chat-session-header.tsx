import {
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
import { Button, Tooltip, TooltipContent, TooltipTrigger } from "@/ui";
import type { ChatSession, ChatSessionRuntimeState } from "./chat-page-utils";

export function SessionHeader({
	session,
	sessionState,
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
				overlay && "absolute inset-x-0 top-0 z-30",
				IS_MACOS && sidebarCollapsed && TRAFFIC_LIGHT_GUTTER,
				reserveWindowControls && "pr-[7.75rem]",
			)}
		>
			<div
				aria-hidden={!sidebarCollapsed}
				className={cn(
					"flex shrink-0 items-center overflow-hidden transition-[width,opacity] duration-200 ease-out motion-reduce:transition-none",
					// 折叠完成后（延迟 200ms 与侧栏收起过渡对齐）淡入，避免展开按钮提前弹出造成跳动
					sidebarCollapsed
						? "w-10 pl-3 opacity-100 delay-200"
						: "w-0 pl-0 opacity-0",
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
						className="group flex h-8 w-fit max-w-[66.666667%] min-w-0 items-center gap-1.5 overflow-hidden rounded-md border border-transparent px-3 text-[13px] text-foreground outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
					>
						<svg
							viewBox="0 0 800 800"
							className="size-3 shrink-0 text-muted-foreground opacity-60"
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
			) : (
				/* 落地页没有会话：用占位保证顶栏几何与有会话时完全一致 */
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
									aria-label="打开不保存记录的会话"
									onClick={onNewTemporaryChat}
								>
									<MessageSquareDashed className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>不保存记录</TooltipContent>
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
