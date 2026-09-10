import { useState } from "react";
import { PanelLeft } from "lucide-react";
import { ChatComposer } from "@/components/chat/chat-composer";
import { cn } from "@/lib/utils";
import { Button } from "@/ui";

export function NewChatLanding({
	onStartSession,
	onExpandSidebar,
	reserveWindowControls = false,
	sidebarCollapsed = false,
}: {
	onStartSession: (prompt: string) => void;
	onExpandSidebar?: () => void;
	reserveWindowControls?: boolean;
	sidebarCollapsed?: boolean;
}) {
	const [draft, setDraft] = useState("");
	return (
		<div className="flex h-full min-w-0 flex-col">
			<header
				data-tauri-drag-region="deep"
				className={cn(
					"flex h-10 shrink-0 items-center gap-2 px-3",
					reserveWindowControls && "pr-[7.75rem]",
				)}
			>
				{sidebarCollapsed && (
					<Button
						variant="ghost"
						size="icon"
						className="size-7 shrink-0"
						aria-label="展开侧边栏"
						onClick={onExpandSidebar}
					>
						<PanelLeft className="size-4" />
					</Button>
				)}
			</header>
			<div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4 pb-8">
				<svg
					viewBox="0 0 800 800"
					className="mb-3 h-16 w-16"
					aria-hidden="true"
				>
					<path
						className="fill-foreground"
						fillRule="evenodd"
						d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
					/>
					<path
						className="fill-foreground"
						d="M517.36 400H634.72V634.72H517.36Z"
					/>
				</svg>
				<h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
					今天想做点什么？
				</h1>
			</div>
			<div className="mx-auto w-full max-w-[46rem] px-3 pb-2 sm:px-4">
				<ChatComposer
					variant="landing"
					value={draft}
					onChange={setDraft}
					onSubmit={onStartSession}
				/>
			</div>
		</div>
	);
}
