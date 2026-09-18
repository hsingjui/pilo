import { ArrowLeft, Search, SquarePen } from "lucide-react";

import type { SidebarProject } from "./types";

export function ProjectSessionsToolbar({
	project,
	totalCount,
	query,
	onQueryChange,
	onBack,
	onNewChat,
}: {
	project: SidebarProject;
	totalCount: number;
	query: string;
	onQueryChange: (query: string) => void;
	onBack: () => void;
	onNewChat?: (projectId: string) => void;
}) {
	return (
		<>
			<div className="flex min-w-0 items-center gap-1">
				<button
					type="button"
					className="group flex min-w-0 flex-1 select-none items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-sidebar-foreground outline-hidden transition hover:bg-sidebar-hover hover:text-sidebar-hover-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring dark:text-sidebar-foreground/75"
					onClick={onBack}
				>
					<ArrowLeft className="h-4 w-4 shrink-0" />
					<span className="min-w-0 flex-1 truncate">{project.name}</span>
					<span className="shrink-0 text-xs tabular-nums text-sidebar-foreground-muted">
						{totalCount}
					</span>
				</button>
				<button
					type="button"
					className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground-muted transition-colors hover:bg-sidebar-hover hover:text-sidebar-hover-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring"
					aria-label={`在 ${project.name} 新建对话`}
					onClick={() => onNewChat?.(project.id)}
				>
					<SquarePen className="h-4 w-4" />
				</button>
			</div>
			<div className="relative">
				<Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-sidebar-foreground-muted" />
				<input
					value={query}
					onChange={(event) => onQueryChange(event.target.value)}
					onKeyDown={(event) => {
						if (event.key !== "Escape") return;
						if (query) onQueryChange("");
						else onBack();
					}}
					placeholder="搜索该项目的会话"
					aria-label="搜索该项目的会话"
					className="h-8 w-full rounded-lg border border-sidebar-border/70 bg-sidebar-foreground/[0.035] pl-8 pr-2 text-xs text-sidebar-foreground outline-hidden placeholder:text-sidebar-foreground-muted focus:border-sidebar-ring/70 focus:ring-2 focus:ring-sidebar-ring/20"
				/>
			</div>
		</>
	);
}
