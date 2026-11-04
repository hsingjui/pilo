import { ChevronDown, Folder } from "lucide-react";
import { useTranslation } from "react-i18next";

import { connectionLabel, type Project } from "@/lib/api/projects";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/ui";

/**
 * 新会话欢迎区中的项目选择器。
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
	const connectionName = project ? connectionLabel(project.connection) : null;
	if (projects.length === 0) return null;
	return (
		<div className="flex w-full min-w-0 justify-center">
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						className="flex min-h-(--pilo-ui-button-sm-height) max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-sm text-muted-foreground outline-hidden transition-colors hover:bg-hover hover:text-hover-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-hover data-[state=open]:text-hover-foreground motion-reduce:transition-none"
						aria-label={
							project
								? `${t("app.selectProject")}: ${project.name} · ${connectionName}`
								: t("app.selectProject")
						}
						title={project ? `${project.name} · ${connectionName}` : undefined}
					>
						<span className="min-w-0 truncate font-medium text-foreground">
							{project?.name ?? t("app.selectProject")}
						</span>
						{connectionName ? (
							<>
								<span aria-hidden="true" className="shrink-0">
									·
								</span>
								<span className="max-w-[50%] min-w-0 truncate text-xs">
									{connectionName}
								</span>
							</>
						) : null}
						<ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="center"
					className="min-w-48 max-w-[calc(100vw-2rem)] [--pilo-ui-menu-item-gap:0.25rem]"
				>
					{projects.map((candidate) => (
						<DropdownMenuItem
							key={candidate.id}
							icon={<Folder aria-hidden="true" />}
							aria-current={project?.id === candidate.id ? "true" : undefined}
							className={
								project?.id === candidate.id
									? "bg-hover text-hover-foreground"
									: undefined
							}
							onClick={() => onSwitchProject?.(candidate.id)}
						>
							<span className="min-w-0 flex-1 truncate font-medium">
								{candidate.name}
							</span>
							<span className="max-w-[50%] min-w-0 truncate text-xs text-muted-foreground">
								{connectionLabel(candidate.connection)}
							</span>
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
