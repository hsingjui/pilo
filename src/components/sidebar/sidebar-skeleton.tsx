import { Skeleton } from "@/ui";

/** 整体刷新时的骨架占位，模拟环境/项目/会话行的层级。 */
const SKELETON_ROW_WIDTHS = ["72%", "58%", "64%", "48%", "68%"] as const;

export function SidebarSkeleton() {
	return (
		<div className="space-y-3 px-1 pt-1" aria-hidden="true">
			{["env-a", "env-b"].map((envKey) => (
				<div key={envKey} className="space-y-1.5">
					<div className="flex items-center gap-2 px-2 py-1">
						<Skeleton className="h-4 w-4 rounded-md" />
						<Skeleton className="h-3.5 w-24" />
					</div>
					{SKELETON_ROW_WIDTHS.map((width) => (
						<div key={width} className="flex items-center gap-2 px-2 py-1.5">
							<Skeleton className="h-4 w-4 shrink-0 rounded-md" />
							<Skeleton className="h-3.5" style={{ width }} />
						</div>
					))}
				</div>
			))}
		</div>
	);
}
