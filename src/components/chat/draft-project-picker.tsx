import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { Project } from "@/lib/projects";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/ui";

/**
 * 新会话落地页输入框上方的项目选择器。
 * Desktop 落地页与 Remote WebUI 共用，避免两处样式漂移。
 */
export function DraftProjectPicker({
	projects,
	project,
	onSwitchProject,
}: {
	projects: readonly Project[];
	project: Project | null;
	onSwitchProject?: (projectId: string) => void;
}) {
	const { t } = useTranslation();
	if (projects.length === 0) return null;
	return (
		<div className="flex pb-1.5 pl-1">
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						className="group flex h-7 w-fit max-w-[66.666667%] min-w-0 items-center gap-1.5 rounded-lg border border-foreground/[0.10] bg-background px-2 text-xs text-muted-foreground outline-hidden transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring dark:border-input-border/70"
						aria-label={t("app.selectProject")}
					>
						<span
							aria-hidden="true"
							className="size-2.5 shrink-0 rounded-[4px] bg-muted-foreground/50"
						/>
						<span className="min-w-0 flex-1 truncate text-left">
							{project ? project.name : t("app.selectProject")}
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
							<span className="min-w-0 flex-1 truncate">{candidate.name}</span>
							{project?.id === candidate.id ? (
								<span className="shrink-0 text-xs text-muted-foreground">
									当前
								</span>
							) : null}
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
