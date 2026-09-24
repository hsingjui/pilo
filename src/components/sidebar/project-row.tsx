/* oxlint-disable jsx-a11y/prefer-tag-over-role -- project rows contain independent action buttons; native outer buttons would create invalid nested interactive controls. */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	ChevronDown,
	Folder,
	MoreHorizontal,
	RefreshCw,
	SquarePen,
	Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
	Spinner,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/ui";
import { menuItemIconClassName } from "@/ui/menu-styles";
import { HOVER_ACTION } from "./sidebar-row-parts";
import type { SidebarEnv, SidebarProject } from "./types";

export function ProjectRow({
	project,
	env,
	collapsed,
	selected,
	refreshing,
	onSelect,
	onToggle,
	onNewChat,
	onDelete,
	onRefreshSessions,
}: {
	project: SidebarProject;
	env: SidebarEnv;
	collapsed: boolean;
	selected: boolean;
	refreshing: boolean;
	onSelect: () => void;
	onToggle: () => void;
	onNewChat?: (projectId: string) => void;
	onDelete?: (projectId: string) => void;
	onRefreshSessions?: () => void;
}) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const { t } = useTranslation();
	const toggleLabel = collapsed
		? t("sidebar.expandProject")
		: t("sidebar.collapseProject");
	return (
		<Tooltip delayDuration={600}>
			<TooltipTrigger asChild>
				{/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- 内嵌图标按钮，不能用原生 button */}
				<div
					role="button"
					tabIndex={0}
					aria-label={
						refreshing
							? t("sidebar.refreshingProject", { name: project.name })
							: project.name
					}
					aria-current={selected ? "page" : undefined}
					aria-disabled={refreshing || undefined}
					data-menu-open={menuOpen || undefined}
					onClick={() => {
						if (refreshing) return;
						onSelect();
					}}
					onKeyDown={(event) => {
						if (event.target !== event.currentTarget) return;
						if (event.key !== "Enter" && event.key !== " ") return;
						event.preventDefault();
						if (refreshing) return;
						onSelect();
					}}
					className={cn(
						"group relative flex min-w-0 w-full cursor-pointer select-none items-center gap-2 rounded-md border border-transparent bg-transparent py-1 pl-2 pr-3 text-left text-xs font-semibold transition-colors",
						"text-sidebar-foreground dark:text-sidebar-foreground/75",
						"hover:bg-sidebar-hover hover:text-sidebar-hover-foreground data-[menu-open]:bg-sidebar-hover data-[menu-open]:text-sidebar-hover-foreground",
						"focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring",
						selected &&
							"border-sidebar-foreground/10 bg-sidebar-foreground/10 text-sidebar-foreground hover:bg-sidebar-foreground/10",
						refreshing &&
							"cursor-default text-sidebar-foreground-muted hover:bg-transparent hover:text-sidebar-foreground-muted",
					)}
				>
					<button
						type="button"
						className="relative -mr-1.5 flex h-5 w-5 shrink-0 items-center justify-center"
						aria-label={toggleLabel}
						aria-expanded={!collapsed}
						disabled={refreshing}
						onClick={(event) => {
							event.preventDefault();
							event.stopPropagation();
							onToggle();
						}}
					>
						<Folder className="absolute left-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-current opacity-80 transition-opacity duration-100 group-hover:opacity-0" />
						<ChevronDown
							className={cn(
								"absolute left-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-current transition-[opacity,transform] duration-150 ease-out",
								"opacity-0 group-hover:opacity-100",
								collapsed ? "-rotate-90" : "rotate-0",
							)}
						/>
					</button>
					<span className="min-w-0 flex-1 truncate text-left">
						{project.name}
					</span>
					<div className="flex shrink-0 items-center gap-0.5">
						{refreshing ? (
							<span
								className="flex h-5 w-5 items-center justify-center text-muted-foreground"
								aria-label={t("sidebar.refreshingSessions")}
							>
								<Spinner className="h-3.5 w-3.5" />
							</span>
						) : null}
						<DropdownMenu
							open={menuOpen}
							onOpenChange={(open) => {
								setMenuOpen(open);
								if (!open) setConfirmingDelete(false);
							}}
						>
							<DropdownMenuTrigger asChild>
								<button
									type="button"
									aria-label={t("sidebar.projectMenu")}
									className={HOVER_ACTION}
									onClick={(event) => event.stopPropagation()}
								>
									<MoreHorizontal className="h-3.5 w-3.5" />
								</button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="start" className="min-w-0 w-32">
								<DropdownMenuItem
									disabled={refreshing}
									onSelect={() => onRefreshSessions?.()}
								>
									<RefreshCw className={menuItemIconClassName} />
									{t("sidebar.refreshSessions")}
								</DropdownMenuItem>
								{onDelete ? (
									<DropdownMenuItem
										variant="destructive"
										disabled={refreshing}
										onSelect={(event) => {
											if (!confirmingDelete) {
												event.preventDefault();
												setConfirmingDelete(true);
												return;
											}
											onDelete(project.id);
										}}
									>
										<Trash2 className={menuItemIconClassName} />
										{confirmingDelete
											? t("sidebar.confirmRemove")
											: t("sidebar.removeProject")}
									</DropdownMenuItem>
								) : null}
							</DropdownMenuContent>
						</DropdownMenu>
						<button
							type="button"
							aria-label={t("sidebar.newSession")}
							className={HOVER_ACTION}
							onClick={(event) => {
								event.preventDefault();
								event.stopPropagation();
								onNewChat?.(project.id);
							}}
						>
							<SquarePen className="h-3.5 w-3.5" />
						</button>
					</div>
				</div>
			</TooltipTrigger>
			<TooltipContent side="right" align="start" className="max-w-[420px]">
				<div className="flex flex-col gap-0.5 text-xs">
					<span>{env.name}</span>
					<span className="break-all font-mono text-2xs leading-snug">
						{project.path}
					</span>
				</div>
			</TooltipContent>
		</Tooltip>
	);
}
