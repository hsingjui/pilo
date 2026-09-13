import { PanelLeft, PanelRight } from "lucide-react";

import { IS_MACOS, TRAFFIC_LIGHT_GUTTER } from "@/components/title-bar";
import { cn } from "@/lib/utils";
import { Button, Tooltip, TooltipContent, TooltipTrigger } from "@/ui";
import type { ChatSession, ChatSessionRuntimeState } from "./chat-page-utils";

export function SessionHeader({
	session,
	sessionState,
	onRename,
	onOpenChanges,
	onExpandSidebar,
	reserveWindowControls = false,
	sidebarCollapsed = false,
}: {
	session: ChatSession;
	sessionState?: ChatSessionRuntimeState;
	onRename?: () => void;
	onOpenChanges?: () => void;
	onExpandSidebar?: () => void;
	reserveWindowControls?: boolean;
	sidebarCollapsed?: boolean;
}) {
	return (
		<header
			data-tauri-drag-region="deep"
			className={cn(
				"mt-0.5 flex h-11 shrink-0 items-center bg-background",
				IS_MACOS && sidebarCollapsed && TRAFFIC_LIGHT_GUTTER,
				reserveWindowControls && "pr-[7.75rem]",
			)}
		>
			{sidebarCollapsed ? (
				<div className="flex shrink-0 items-center pl-3">
					<Button
						variant="ghost"
						size="icon"
						className="size-7 shrink-0 text-muted-foreground"
						aria-label="展开侧边栏"
						onClick={onExpandSidebar}
					>
						<PanelLeft className="size-4" />
					</Button>
				</div>
			) : null}
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
					onDoubleClick={onRename}
					title={onRename ? "双击重命名" : undefined}
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
			{onOpenChanges ? (
				<div className="flex shrink-0 items-center gap-1 pr-2">
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
				</div>
			) : null}
		</header>
	);
}
