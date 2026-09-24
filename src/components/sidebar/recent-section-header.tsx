import { useTranslation } from "react-i18next";
import { ChevronDown, Clock, Folder, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@/ui";
import { menuItemIconClassName } from "@/ui/menu-styles";
import { MiniSwitch, ViewMenuItem } from "./sidebar-row-parts";
import type { SidebarEnvView } from "./types";

/**
 * “最近会话”视图的分区标题（参考 Lody SidebarSectionHeader）：
 * 可折叠/展开；操作菜单融进标题行的 MoreHorizontal——连接和项目树
 * 隐藏后，这里是用户切回“项目”视图的入口。
 */
export function RecentSectionHeader({
	collapsed,
	onToggle,
	view,
	onViewChange,
	showProjects,
	onShowProjectsChange,
}: {
	collapsed: boolean;
	onToggle: () => void;
	/** 侧栏组织模式（全局）。 */
	view: SidebarEnvView;
	onViewChange?: (view: SidebarEnvView) => void;
	/** 「展示项目」开关（“最近会话”模式下控制会话行是否带项目名）。 */
	showProjects: boolean;
	onShowProjectsChange?: (showProjects: boolean) => void;
}) {
	const { t } = useTranslation();
	const toggleLabel = collapsed
		? t("sidebar.expandRecent")
		: t("sidebar.collapseRecent");
	return (
		<div className="group flex h-7 items-center gap-1 rounded-md">
			<button
				type="button"
				aria-label={toggleLabel}
				aria-expanded={!collapsed}
				onClick={onToggle}
				className={cn(
					"relative flex h-7 min-w-0 flex-1 select-none items-center gap-2 rounded-md border border-transparent bg-transparent px-2 text-left",
					"text-sm font-medium text-sidebar-foreground-muted transition-colors hover:text-sidebar-foreground",
					"focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring",
				)}
			>
				<Clock className="h-3.5 w-3.5 shrink-0 opacity-80" />
				<span className="min-w-0 truncate">{t("sidebar.recentSessions")}</span>
				<ChevronDown
					className={cn(
						"h-3.5 w-3.5 shrink-0 text-current transition-[opacity,transform] duration-150 ease-out",
						collapsed
							? "-rotate-90 opacity-100"
							: "opacity-0 group-hover:opacity-100",
					)}
				/>
			</button>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
						aria-label={t("sidebar.recentMenu")}
					>
						<MoreHorizontal className="h-3.5 w-3.5" />
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="min-w-0 w-40">
					{onViewChange ? (
						<>
							<DropdownMenuLabel>{t("sidebar.view")}</DropdownMenuLabel>
							<ViewMenuItem
								icon={Folder}
								label={t("sidebar.projects")}
								selected={view === "projects"}
								onSelect={() => onViewChange("projects")}
							/>
							<ViewMenuItem
								icon={Clock}
								label={t("sidebar.recentSessions")}
								selected={view === "recent"}
								onSelect={() => onViewChange("recent")}
							/>
							<DropdownMenuItem
								data-show-projects={showProjects || undefined}
								onSelect={() => onShowProjectsChange?.(!showProjects)}
							>
								<Folder className={menuItemIconClassName} />
								<span className="min-w-0 flex-1 whitespace-nowrap">
									{t("sidebar.showProjects")}
								</span>
								<MiniSwitch checked={showProjects} />
							</DropdownMenuItem>
						</>
					) : null}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
