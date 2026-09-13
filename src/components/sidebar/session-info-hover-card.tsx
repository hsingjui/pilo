import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { Folder, Monitor } from "lucide-react";
import { formatCompactRelativeTime } from "@/lib/relative-time";
import { Popover, PopoverAnchor, PopoverContent } from "@/ui";

const OPEN_DELAY_MS = 600;
const CLOSE_DELAY_MS = 180;

// 全局同时只允许一张卡片打开：新卡片打开时立刻关掉上一张，
// 光标扫过列表不会出现两张卡片叠影（Lody session-info-hover-card 模式）。
let activeCardClose: (() => void) | null = null;

function SessionInfoCard({
	title,
	latestMessageAt,
	now,
	projectName,
	envName,
}: {
	title: string;
	latestMessageAt: Date;
	now: Date;
	projectName?: string;
	envName?: string;
}) {
	const rows: Array<{ key: string; icon: ReactNode; value: string }> = [];
	if (projectName) {
		rows.push({
			key: "project",
			icon: <Folder className="h-3.5 w-3.5" />,
			value: projectName,
		});
	}
	if (envName) {
		rows.push({
			key: "env",
			icon: <Monitor className="h-3.5 w-3.5" />,
			value: envName,
		});
	}
	return (
		<div className="flex w-[16.5rem] flex-col rounded-lg border border-border bg-popover p-2.5 text-xs text-popover-foreground shadow-md">
			<div className="mb-2 flex items-baseline gap-2">
				<span className="min-w-0 flex-1 truncate text-sm" title={title}>
					{title}
				</span>
				<span className="shrink-0 tabular-nums text-muted-foreground">
					{formatCompactRelativeTime(latestMessageAt, now)}
				</span>
			</div>
			{rows.length > 0 ? (
				<div className="flex flex-col gap-1">
					{rows.map((row) => (
						<div key={row.key} className="flex items-center gap-2">
							<span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted-foreground">
								{row.icon}
							</span>
							<span className="min-w-0 flex-1 truncate">{row.value}</span>
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}

export function SessionInfoHoverCard({
	children,
	now,
	...card
}: {
	children: ReactNode;
	now: Date;
	title: string;
	latestMessageAt: Date;
	projectName?: string;
	envName?: string;
}) {
	const [open, setOpen] = useState(false);
	const openRef = useRef(false);
	const closeTimer = useRef<number | null>(null);
	const openTimer = useRef<number | null>(null);

	const clearClose = useCallback(() => {
		if (closeTimer.current !== null) {
			window.clearTimeout(closeTimer.current);
			closeTimer.current = null;
		}
	}, []);

	const clearOpen = useCallback(() => {
		if (openTimer.current !== null) {
			window.clearTimeout(openTimer.current);
			openTimer.current = null;
		}
	}, []);

	const closeSelf = useCallback(() => {
		clearClose();
		clearOpen();
		openRef.current = false;
		setOpen(false);
	}, [clearClose, clearOpen]);

	const openNow = useCallback(() => {
		clearClose();
		clearOpen();
		if (activeCardClose && activeCardClose !== closeSelf) activeCardClose();
		activeCardClose = closeSelf;
		openRef.current = true;
		setOpen(true);
	}, [clearClose, clearOpen, closeSelf]);

	const requestOpen = useCallback(() => {
		clearClose();
		if (openRef.current) return;
		clearOpen();
		openTimer.current = window.setTimeout(openNow, OPEN_DELAY_MS);
	}, [clearClose, clearOpen, openNow]);

	const scheduleClose = useCallback(() => {
		clearOpen();
		closeTimer.current = window.setTimeout(closeSelf, CLOSE_DELAY_MS);
	}, [clearOpen, closeSelf]);

	useEffect(() => {
		if (!open && activeCardClose === closeSelf) activeCardClose = null;
	}, [open, closeSelf]);

	useEffect(
		() => () => {
			clearClose();
			clearOpen();
			if (activeCardClose === closeSelf) activeCardClose = null;
		},
		[clearClose, clearOpen, closeSelf],
	);

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				if (!next) closeSelf();
			}}
		>
			<PopoverAnchor asChild>
				<div
					className="w-full min-w-0 overflow-hidden"
					onPointerEnter={requestOpen}
					onPointerLeave={scheduleClose}
				>
					{children}
				</div>
			</PopoverAnchor>
			<PopoverContent
				side="right"
				align="start"
				sideOffset={6}
				collisionPadding={12}
				onOpenAutoFocus={(event) => event.preventDefault()}
				onPointerEnter={clearClose}
				onPointerLeave={scheduleClose}
				className="w-auto overflow-visible p-0"
			>
				<SessionInfoCard {...card} now={now} />
			</PopoverContent>
		</Popover>
	);
}
