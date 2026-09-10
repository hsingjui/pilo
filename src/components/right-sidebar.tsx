import { type RefObject } from "react";
import { Panel, type PanelImperativeHandle } from "react-resizable-panels";
import { FileCode, PanelRight } from "lucide-react";

import { CUSTOM_TITLEBAR } from "@/components/title-bar";
import { cn } from "@/lib/utils";
import { Button, Separator } from "@/ui";

const PLACEHOLDER_CHANGES = [
	{ name: "src/App.tsx", add: 12, del: 3 },
	{ name: "src-tauri/tauri.conf.json", add: 6, del: 1 },
	{ name: "src/ui/button.tsx", add: 2, del: 0 },
	{ name: "src/index.css", add: 14, del: 4 },
];

export function RightSidebar({
	panelRef,
	resizing,
}: {
	panelRef: RefObject<PanelImperativeHandle | null>;
	resizing: boolean;
}) {
	return (
		<Panel
			panelRef={panelRef}
			defaultSize={0}
			minSize={200}
			collapsible
			collapsedSize={0}
			// 折叠/展开过渡动画；拖拽时关闭，避免 flex-grow 动画跟不上指针
			className={cn(
				"min-w-0",
				!resizing && "transition-[flex-grow] duration-200 ease-out",
			)}
		>
			<aside className="flex h-full min-w-0 flex-col border-l border-sidebar-border bg-sidebar text-sidebar-foreground">
				<header
					data-tauri-drag-region="deep"
					className={cn(
						"flex h-10 shrink-0 items-center gap-2 px-3",
						CUSTOM_TITLEBAR && "pr-[7.75rem]",
					)}
				>
					<span className="text-sm font-semibold">变更</span>
					<Button
						variant="ghost"
						size="icon"
						className="ms-auto size-7"
						aria-label="收起右侧栏"
						onClick={() => panelRef.current?.collapse()}
					>
						<PanelRight className="size-4" />
					</Button>
				</header>
				<Separator className="bg-sidebar-border" />
				<div className="min-h-0 flex-1 overflow-y-auto p-2">
					<ul className="grid gap-0.5">
						{PLACEHOLDER_CHANGES.map((change) => (
							<li
								key={change.name}
								className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm"
							>
								<FileCode
									size={14}
									className="shrink-0 text-sidebar-foreground-muted"
								/>
								<span className="min-w-0 flex-1 truncate">{change.name}</span>
								<span className="font-mono text-xs text-primary">
									+{change.add}
								</span>
								<span className="font-mono text-xs text-destructive">
									-{change.del}
								</span>
							</li>
						))}
					</ul>
				</div>
			</aside>
		</Panel>
	);
}
