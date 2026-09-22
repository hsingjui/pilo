import {
	MessageSquareDashed,
	PanelLeft,
	PanelRight,
	TerminalSquare,
} from "lucide-react";
import { useTranslation } from "react-i18next";

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
	const { t } = useTranslation();
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
			{session && !session.temporary ? (
				<div
					role="tablist"
					aria-label={t("common.sessions")}
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
			) : (
				/* 没有会话：占位保证顶栏几何一致（落地页项目选择已移至输入框上方） */
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
					{onNewTemporaryChat ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="ghost"
									size="icon"
									className="size-7"
									aria-label={t("app.temporaryChat")}
									onClick={onNewTemporaryChat}
								>
									<MessageSquareDashed className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>{t("app.temporaryChat")}</TooltipContent>
						</Tooltip>
					) : null}
					{onOpenChanges ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="ghost"
									size="icon"
									className="size-7"
									aria-label={t("chat.showChanges")}
									onClick={onOpenChanges}
								>
									<PanelRight className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>{t("chat.showChanges")}</TooltipContent>
						</Tooltip>
					) : null}
				</div>
			) : null}
		</header>
	);
}
