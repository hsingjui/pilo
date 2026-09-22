import { ArrowLeft, SquarePen } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { SidebarProject } from "./types";

export function ProjectSessionsToolbar({
	project,
	onBack,
	onNewChat,
}: {
	project: SidebarProject;
	onBack: () => void;
	onNewChat?: (projectId: string) => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="flex min-w-0 items-center gap-1">
			<button
				type="button"
				className="group flex min-w-0 flex-1 select-none items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-sm text-sidebar-foreground outline-hidden transition-colors hover:bg-sidebar-hover hover:text-sidebar-hover-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring dark:text-sidebar-foreground/75"
				onClick={onBack}
			>
				<ArrowLeft className="h-4 w-4 shrink-0" />
				<span className="min-w-0 flex-1 truncate">{project.name}</span>
			</button>
			<button
				type="button"
				className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground-muted transition-colors hover:bg-sidebar-hover hover:text-sidebar-hover-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring"
				aria-label={t("sidebar.newSession")}
				onClick={() => onNewChat?.(project.id)}
			>
				<SquarePen className="h-4 w-4" />
			</button>
		</div>
	);
}
