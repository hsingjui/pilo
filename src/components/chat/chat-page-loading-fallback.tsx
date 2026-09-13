import { ArrowUp, Bot, Plus } from "lucide-react";

import {
	CHAT_COMPOSER_ATTACHMENT_BUTTON_CLASS_NAME,
	CHAT_COMPOSER_RUN_CONFIG_TRIGGER_CLASS_NAME,
	CHAT_COMPOSER_SEND_BUTTON_CLASS_NAME,
	CHAT_COMPOSER_TEXTAREA_CLASS_NAME,
	CHAT_COMPOSER_TOOLBAR_CLASS_NAME,
	DEFAULT_CHAT_COMPOSER_PLACEHOLDER,
	ChatComposerRoot,
	ChatComposerSurface,
} from "@/components/chat/chat-composer-frame";
import { ChatHistorySkeleton } from "@/components/chat/chat-history-skeleton";
import type { ChatSession } from "@/components/chat/chat-page-utils";
import { IS_MACOS, TRAFFIC_LIGHT_GUTTER } from "@/components/title-bar";
import { cn } from "@/lib/utils";
import { Button, Textarea } from "@/ui";

function LoadingHeader({
	session,
	reserveWindowControls,
	sidebarCollapsed,
}: {
	session: ChatSession;
	reserveWindowControls: boolean;
	sidebarCollapsed: boolean;
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
			{sidebarCollapsed ? <div className="w-10 shrink-0" /> : null}
			<div className="flex min-w-0 flex-1 items-center px-1">
				<div className="flex h-8 w-full min-w-0 items-center gap-1.5 px-3 text-[13px] text-foreground">
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
					<span className="truncate">{session.title}</span>
				</div>
			</div>
			<div className="w-10 shrink-0 pr-2" />
		</header>
	);
}

function LoadingComposer() {
	return (
		<div className="relative -mt-4 w-full shrink-0 pb-4 pr-2">
			<div className="mx-auto w-full max-w-[46rem] px-3 sm:px-4">
				<ChatComposerRoot>
					<ChatComposerSurface>
						<Textarea
							value=""
							readOnly
							disabled
							rows={2}
							placeholder={DEFAULT_CHAT_COMPOSER_PLACEHOLDER}
							className={CHAT_COMPOSER_TEXTAREA_CLASS_NAME}
						/>
						<div className={CHAT_COMPOSER_TOOLBAR_CLASS_NAME}>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className={CHAT_COMPOSER_ATTACHMENT_BUTTON_CLASS_NAME}
								aria-label="添加附件"
								tabIndex={-1}
							>
								<Plus className="size-4" />
							</Button>
							<button
								type="button"
								disabled
								tabIndex={-1}
								aria-label="运行配置"
								className={CHAT_COMPOSER_RUN_CONFIG_TRIGGER_CLASS_NAME}
							>
								<Bot className="size-4 shrink-0" />
								<span className="block min-w-0 max-w-40 truncate text-left">
									Pi 默认
								</span>
								<span
									aria-hidden="true"
									className="shrink-0 text-muted-foreground/60"
								>
									·
								</span>
								<span className="shrink-0">关闭</span>
							</button>
							<Button
								type="button"
								size="icon"
								className={CHAT_COMPOSER_SEND_BUTTON_CLASS_NAME}
								aria-label="发送"
								disabled
								tabIndex={-1}
							>
								<ArrowUp className="size-4" />
							</Button>
						</div>
					</ChatComposerSurface>
				</ChatComposerRoot>
			</div>
		</div>
	);
}

export function ChatPageLoadingFallback({
	session,
	reserveWindowControls = false,
	sidebarCollapsed = false,
}: {
	session: ChatSession;
	reserveWindowControls?: boolean;
	sidebarCollapsed?: boolean;
}) {
	return (
		<div className="flex h-full min-w-0 flex-col bg-background">
			<LoadingHeader
				session={session}
				reserveWindowControls={reserveWindowControls}
				sidebarCollapsed={sidebarCollapsed}
			/>
			<div className="relative flex min-h-0 flex-1 flex-col">
				<div className="scrollbar-pro min-h-0 w-full flex-1 overflow-hidden [scrollbar-gutter:stable]">
					<ChatHistorySkeleton />
				</div>
				<LoadingComposer />
			</div>
		</div>
	);
}
