import {
	useEffect,
	useRef,
	useState,
	type ReactNode,
	type RefObject,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
	Group,
	Panel,
	Separator as ResizeSeparator,
	type PanelImperativeHandle,
} from "react-resizable-panels";
import {
	ArrowUp,
	Clock,
	FileCode,
	Folder,
	HelpCircle,
	Minus,
	Monitor,
	Moon,
	PanelLeft,
	PanelRight,
	Pen,
	Plus,
	Settings,
	SlidersHorizontal,
	Square,
	SquareSquare,
	Sun,
	X,
} from "lucide-react";

import { nextCycledTheme, useTheme, type Theme } from "@/lib/theme-provider";
import { cn } from "@/lib/utils";
import {
	Avatar,
	AvatarFallback,
	Badge,
	Button,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	Checkbox,
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
	Input,
	Label,
	ScrollArea,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Separator,
	Switch,
	Textarea,
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/ui";

const PLACEHOLDER_SESSIONS = [
	{ title: "初始化前端风格体系", active: true },
	{ title: "连接管理实现讨论", active: true },
	{ title: "Pi RPC 接入方案", active: true },
	{ title: "Workspace 索引设计", active: false },
	{ title: "远程开发环境调研", active: false },
	{ title: "会话列表持久化", active: false },
];

const THEME_LABELS: Record<Theme, string> = {
	light: "亮色",
	dark: "暗色",
	system: "跟随系统",
};

const THEME_ICONS: Record<Theme, typeof Sun> = {
	light: Sun,
	dark: Moon,
	system: Monitor,
};

// 自定义标题栏仅在 Windows 且运行于 Tauri 时启用（macOS 保留原生窗口装饰）
const CUSTOM_TITLEBAR =
	navigator.userAgent.includes("Windows") && "__TAURI_INTERNALS__" in window;

const CAPTION_BUTTON =
	"mx-1 my-1 flex h-[calc(100%-0.5rem)] w-8 items-center justify-center rounded-md text-foreground/75 transition-colors hover:bg-foreground/5 hover:text-foreground";
const CAPTION_CLOSE = "hover:bg-destructive hover:text-destructive-foreground";

function CaptionButton({
	label,
	onClick,
	danger,
	children,
}: {
	label: string;
	onClick: () => void;
	danger?: boolean;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			onClick={onClick}
			className={`${CAPTION_BUTTON} ${danger ? CAPTION_CLOSE : ""}`}
		>
			{children}
		</button>
	);
}

// Windows 原生 caption 图标：最小化/最大化/还原/关闭
const CAPTION_MIN = <Minus size={15} />;
const CAPTION_MAX = <Square size={14} />;
const CAPTION_RESTORE = <SquareSquare size={14} />;
const CAPTION_CLOSE_ICON = <X size={15} />;

function WindowControls() {
	const win = getCurrentWindow();
	const [maximized, setMaximized] = useState(false);
	useEffect(() => {
		let unlisten: (() => void) | undefined;
		win.isMaximized().then(setMaximized);
		win
			.onResized(() => {
				win.isMaximized().then(setMaximized);
			})
			.then((fn) => (unlisten = fn));
		return () => unlisten?.();
	}, [win]);
	return (
		<div className="flex h-full items-stretch">
			<CaptionButton label="最小化" onClick={() => win.minimize()}>
				{CAPTION_MIN}
			</CaptionButton>
			<CaptionButton
				label={maximized ? "还原" : "最大化"}
				onClick={() => win.toggleMaximize()}
			>
				{maximized ? CAPTION_RESTORE : CAPTION_MAX}
			</CaptionButton>
			<CaptionButton label="关闭" danger onClick={() => win.close()}>
				{CAPTION_CLOSE_ICON}
			</CaptionButton>
		</div>
	);
}

function TitleBar() {
	return (
		<header
			data-tauri-drag-region="deep"
			className="flex h-10 shrink-0 items-start justify-end"
		>
			<WindowControls />
		</header>
	);
}

function ThemeCycleButton() {
	const { theme, setTheme } = useTheme();
	const Icon = THEME_ICONS[theme];
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					aria-label="切换主题"
					onClick={() => setTheme(nextCycledTheme(theme))}
				>
					<Icon />
				</Button>
			</TooltipTrigger>
			<TooltipContent>主题：{THEME_LABELS[theme]}</TooltipContent>
		</Tooltip>
	);
}

function SettingsDialog() {
	const { theme, setTheme } = useTheme();
	return (
		<Dialog>
			<Tooltip>
				<TooltipTrigger asChild>
					<span>
						<DialogTrigger asChild>
							<Button variant="ghost" size="icon" aria-label="设置">
								<Settings />
							</Button>
						</DialogTrigger>
					</span>
				</TooltipTrigger>
				<TooltipContent>设置</TooltipContent>
			</Tooltip>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>设置</DialogTitle>
				</DialogHeader>
				<Card>
					<CardHeader>
						<CardTitle className="text-base">外观</CardTitle>
					</CardHeader>
					<CardContent className="flex items-center justify-between gap-4">
						<Label htmlFor="theme-select">主题</Label>
						<Select value={theme} onValueChange={(v) => setTheme(v as Theme)}>
							<SelectTrigger id="theme-select" className="w-40">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{(Object.keys(THEME_LABELS) as Theme[]).map((t) => (
									<SelectItem key={t} value={t}>
										{THEME_LABELS[t]}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle className="text-base">通用</CardTitle>
					</CardHeader>
					<CardContent className="grid gap-4">
						<div className="flex items-center justify-between gap-4">
							<Label htmlFor="display-name">昵称</Label>
							<Input
								id="display-name"
								placeholder="Pilo 用户"
								className="w-40"
							/>
						</div>
						<div className="flex items-center justify-between gap-4">
							<Label htmlFor="notifications">启用通知</Label>
							<Switch id="notifications" />
						</div>
						<div className="flex items-center justify-between gap-4">
							<Label htmlFor="auto-update">自动检查更新</Label>
							<Checkbox id="auto-update" defaultChecked />
						</div>
					</CardContent>
				</Card>
			</DialogContent>
		</Dialog>
	);
}

function Sidebar() {
	return (
		<aside className="h-full shrink-0 p-2">
			<div className="flex h-full w-64 flex-col rounded-xl border border-sidebar-border/80 bg-sidebar text-sidebar-foreground shadow-xs">
				<header
					data-tauri-drag-region="deep"
					className="flex items-center gap-2 px-3 py-2.5"
				>
					<Avatar className="size-6 rounded-md">
						<AvatarFallback className="rounded-md bg-primary text-xs font-semibold text-primary-foreground">
							P
						</AvatarFallback>
					</Avatar>
					<span className="text-sm font-semibold">Pilo</span>
					<Button
						variant="ghost"
						size="icon"
						className="ms-auto size-7"
						aria-label="收起侧边栏"
					>
						<PanelLeft />
					</Button>
				</header>
				<div className="px-2">
					<Button
						variant="ghost"
						className="w-full justify-start gap-2 text-sidebar-foreground"
					>
						<Pen size={16} />
						新对话
					</Button>
				</div>
				<div className="mt-1 flex items-center gap-2 px-3 py-1.5 text-sm text-sidebar-foreground-muted">
					<Monitor size={16} className="text-sidebar-foreground-muted" />
					<span>本地</span>
					<Button
						variant="ghost"
						size="icon"
						className="ms-auto size-7"
						aria-label="连接设置"
					>
						<SlidersHorizontal />
					</Button>
				</div>
				<div className="px-2">
					<button
						type="button"
						className="flex w-full items-center gap-2 rounded-md border border-sidebar-border bg-sidebar-selection px-2 py-1.5 text-sm font-medium text-sidebar-selection-foreground shadow-xs"
					>
						<Folder size={16} />
						pilo
					</button>
				</div>
				<ScrollArea className="min-h-0 flex-1 px-4">
					<ul className="grid gap-0.5 py-1">
						{PLACEHOLDER_SESSIONS.map((session) => (
							<li key={session.title}>
								<button
									type="button"
									className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-sidebar-foreground hover:bg-sidebar-hover hover:text-sidebar-hover-foreground"
								>
									<span className="min-w-0 flex-1 truncate">
										{session.title}
									</span>
									{session.active && (
										<span className="size-1.5 shrink-0 rounded-full bg-primary" />
									)}
								</button>
							</li>
						))}
					</ul>
				</ScrollArea>
				<Separator className="bg-sidebar-border" />
				<footer className="flex items-center gap-1 px-2 py-1.5">
					<SettingsDialog />
					<Tooltip>
						<TooltipTrigger asChild>
							<Button variant="ghost" size="icon" aria-label="帮助">
								<HelpCircle />
							</Button>
						</TooltipTrigger>
						<TooltipContent>帮助</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button variant="ghost" size="icon" aria-label="历史">
								<Clock />
							</Button>
						</TooltipTrigger>
						<TooltipContent>历史</TooltipContent>
					</Tooltip>
					<span className="ms-auto">
						<ThemeCycleButton />
					</span>
				</footer>
			</div>
		</aside>
	);
}

function Composer() {
	return (
		<div className="mx-auto w-full max-w-2xl px-4 pb-4">
			<div className="mb-2 flex items-center gap-1.5">
				<Badge variant="outline" className="gap-1 bg-background font-normal">
					<Monitor size={12} />
					本地
				</Badge>
				<Badge variant="outline" className="gap-1 bg-background font-normal">
					<Folder size={12} />
					pilo
				</Badge>
			</div>
			<div className="rounded-xl border border-foreground/10 bg-input-field shadow-xs dark:border-input-border/70">
				<Textarea
					placeholder="按 '@' 添加提及，'$' 使用技能。"
					className="min-h-20 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
				/>
				<div className="flex items-center gap-2 px-3 pb-2.5">
					<Button variant="ghost" size="icon" aria-label="添加附件">
						<Plus />
					</Button>
					<Badge variant="outline" className="font-mono font-normal">
						pi / default
					</Badge>
					<span className="ms-auto" />
					<Button size="icon" className="rounded-full" aria-label="发送">
						<ArrowUp />
					</Button>
				</div>
			</div>
		</div>
	);
}

const PLACEHOLDER_CHANGES = [
	{ name: "src/App.tsx", add: 12, del: 3 },
	{ name: "src-tauri/tauri.conf.json", add: 6, del: 1 },
	{ name: "src/ui/button.tsx", add: 2, del: 0 },
	{ name: "src/index.css", add: 14, del: 4 },
];

function RightSidebar({
	panelRef,
	onCollapsedChange,
}: {
	panelRef: RefObject<PanelImperativeHandle | null>;
	onCollapsedChange: (collapsed: boolean) => void;
}) {
	return (
		<Panel
			panelRef={panelRef}
			defaultSize={260}
			minSize={200}
			collapsible
			collapsedSize={0}
			onResize={(size) => onCollapsedChange(size.inPixels <= 1)}
			className="min-w-0"
		>
			<aside className="flex h-full min-w-0 flex-col border-l border-sidebar-border bg-sidebar text-sidebar-foreground">
				<header className="flex h-10 shrink-0 items-center gap-2 px-3">
					<span className="text-sm font-semibold">变更</span>
					<Button
						variant="ghost"
						size="icon"
						className="ms-auto size-7"
						aria-label="收起右侧栏"
						onClick={() => panelRef.current?.collapse()}
					>
						<PanelRight />
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

function App() {
	const rightPanelRef = useRef<PanelImperativeHandle>(null);
	const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false);

	return (
		<TooltipProvider>
			<div className="flex h-full bg-background text-foreground">
				<Sidebar />
				<main className="relative flex min-w-0 flex-1 flex-col">
					{CUSTOM_TITLEBAR && <TitleBar />}
					<Group orientation="horizontal" className="min-h-0 flex-1">
						<Panel defaultSize={560} minSize={400} className="min-w-0">
							<div className="flex h-full min-w-0 flex-col">
								<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
									<svg
										viewBox="0 0 800 800"
										className="h-20 w-20"
										aria-hidden="true"
									>
										<path
											fill="currentColor"
											fillRule="evenodd"
											d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
										/>
										<path
											fill="currentColor"
											d="M517.36 400H634.72V634.72H517.36Z"
										/>
									</svg>
									<h1 className="text-4xl font-semibold tracking-tight">
										今天想做点什么？
									</h1>
								</div>
								<Composer />
							</div>
						</Panel>
						<ResizeSeparator className="w-1 bg-transparent transition-colors hover:bg-sidebar-border" />
						<RightSidebar
							panelRef={rightPanelRef}
							onCollapsedChange={setRightPanelCollapsed}
						/>
					</Group>
					{rightPanelCollapsed && (
						<Button
							variant="ghost"
							size="icon"
							aria-label="展开右侧栏"
							onClick={() => rightPanelRef.current?.expand()}
							className={cn(
								"absolute left-2 z-10 h-7 w-7 text-foreground/75",
								CUSTOM_TITLEBAR ? "top-[calc(2.5rem+0.5rem)]" : "top-2",
							)}
						>
							<PanelRight />
						</Button>
					)}
				</main>
			</div>
		</TooltipProvider>
	);
}

export default App;
