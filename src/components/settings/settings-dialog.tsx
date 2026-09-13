import { useEffect, useState } from "react";
import {
	Activity,
	Bell,
	Info,
	Keyboard,
	MessagesSquare,
	Palette,
	Plug,
	SlidersHorizontal,
	SquareTerminal,
} from "lucide-react";
import { toast } from "sonner";

import {
	ensureDesktopNotificationPermission,
	getDesktopNotificationPermission,
	sendDesktopNotificationTest,
	type DesktopNotificationPermission,
} from "@/lib/desktop-notifications";
import {
	CODE_FONT_SIZES,
	MONOSPACE_FONT_OPTIONS,
	PAGE_FONT_OPTIONS,
	PAGE_FONT_SIZES,
	TERMINAL_FONT_SIZES,
	type CodeFontSize,
	type MonospaceFontFamily,
	type PageFontFamily,
	type PageFontSize,
	type TerminalFontSize,
} from "@/lib/font-settings";
import {
	usePreferences,
	type SendMessageShortcut,
} from "@/lib/preferences-provider";
import { useTheme, type Theme } from "@/lib/theme-provider";
import { cn } from "@/lib/utils";
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
	Input,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Switch,
} from "@/ui";
import { SettingsRow, SettingsSection } from "./compact-layout";
import { ConnectionsSettings } from "./connections-settings";
import {
	DiagnosticsSettings,
	PiSettings,
	SessionSettings,
	SettingsStatus,
} from "./project-settings-placeholders";

type SettingsTabId =
	| "preferences"
	| "notifications"
	| "appearance"
	| "shortcuts"
	| "connections"
	| "sessions"
	| "pi"
	| "diagnostics"
	| "about";

const SETTINGS_TABS = [
	{
		id: "preferences" as const,
		section: "个人",
		label: "偏好设置",
		icon: SlidersHorizontal,
	},
	{
		id: "appearance" as const,
		section: "个人",
		label: "外观",
		icon: Palette,
	},
	{
		id: "notifications" as const,
		section: "个人",
		label: "通知",
		icon: Bell,
	},
	{
		id: "shortcuts" as const,
		section: "个人",
		label: "快捷键",
		icon: Keyboard,
	},
	{
		id: "connections" as const,
		section: "项目",
		label: "连接",
		icon: Plug,
	},
	{
		id: "sessions" as const,
		section: "项目",
		label: "会话",
		icon: MessagesSquare,
	},
	{
		id: "pi" as const,
		section: "项目",
		label: "Pi",
		icon: SquareTerminal,
	},
	{
		id: "diagnostics" as const,
		section: "其他",
		label: "诊断",
		icon: Activity,
	},
	{
		id: "about" as const,
		section: "其他",
		label: "关于",
		icon: Info,
	},
];

const THEME_LABELS: Record<Theme, string> = {
	light: "亮色",
	dark: "暗色",
	system: "跟随系统",
};

const FONT_SETTINGS_ROW_CLASS =
	"sm:grid-cols-[minmax(180px,1fr)_minmax(280px,1.35fr)]";

function PreferencesSettings() {
	const {
		sendMessageShortcut,
		setSendMessageShortcut,
		collapseCompletedActivity,
		setCollapseCompletedActivity,
		showWorkDuration,
		setShowWorkDuration,
	} = usePreferences();

	return (
		<div className="space-y-3">
			<SettingsSection title="对话">
				<SettingsRow
					label="发送消息"
					helper="选择输入框中用于发送消息的快捷键。"
				>
					<Select
						value={sendMessageShortcut}
						onValueChange={(value) =>
							setSendMessageShortcut(value as SendMessageShortcut)
						}
					>
						<SelectTrigger className="w-[220px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="enter">Enter 发送</SelectItem>
							<SelectItem value="mod-enter">Ctrl/⌘ + Enter 发送</SelectItem>
						</SelectContent>
					</Select>
				</SettingsRow>
				<SettingsRow
					label="回复完成后收起工作详情"
					helper="完成回复时自动收起中间回复、思考与工具调用，只保留最终回答展开。"
				>
					<Switch
						checked={collapseCompletedActivity}
						onCheckedChange={setCollapseCompletedActivity}
					/>
				</SettingsRow>
				<SettingsRow
					label="显示工作耗时"
					helper="在回复完成后显示 Pi 本轮实际工作的时间。"
				>
					<Switch
						checked={showWorkDuration}
						onCheckedChange={setShowWorkDuration}
					/>
				</SettingsRow>
			</SettingsSection>

			<SettingsSection title="桌面端">
				<SettingsRow
					label="开机自动启动"
					helper="登录 Windows 后自动启动 Pilo，并恢复上次打开的项目。"
				>
					<SettingsStatus muted>规划中</SettingsStatus>
				</SettingsRow>
				<SettingsRow
					label="自动检查更新"
					helper="使用 Tauri updater 检查新版本，安装行为由用户确认。"
				>
					<SettingsStatus muted>规划中</SettingsStatus>
				</SettingsRow>
			</SettingsSection>
		</div>
	);
}

const NOTIFICATION_PERMISSION_LABELS: Record<
	DesktopNotificationPermission,
	string
> = {
	granted: "已允许",
	denied: "已拒绝",
	default: "未请求",
	unsupported: "不可用",
};

function NotificationSettings() {
	const { desktopNotifications, setDesktopNotifications } = usePreferences();
	const [permission, setPermission] =
		useState<DesktopNotificationPermission>("default");
	const [checking, setChecking] = useState(true);
	const [testing, setTesting] = useState(false);

	const refreshPermission = async () => {
		setChecking(true);
		const next = await getDesktopNotificationPermission();
		setPermission(next);
		setChecking(false);
		if (next !== "granted" && desktopNotifications)
			setDesktopNotifications(false);
	};

	useEffect(() => {
		let active = true;
		void getDesktopNotificationPermission().then((next) => {
			if (!active) return;
			setPermission(next);
			setChecking(false);
		});
		return () => {
			active = false;
		};
	}, []);

	const handleNotificationsChange = async (enabled: boolean) => {
		if (!enabled) {
			setDesktopNotifications(false);
			return;
		}
		const granted = await ensureDesktopNotificationPermission();
		setPermission(await getDesktopNotificationPermission());
		setDesktopNotifications(granted);
		if (!granted) {
			toast.error("未能启用系统通知", {
				description: "请在系统通知设置中允许 Pilo 发送通知。",
			});
		}
	};

	const handleTestNotification = async () => {
		setTesting(true);
		const sent = await sendDesktopNotificationTest();
		setPermission(await getDesktopNotificationPermission());
		setTesting(false);
		if (!sent) toast.error("测试通知发送失败");
	};

	return (
		<div className="space-y-3">
			<SettingsSection title="系统通知">
				<SettingsRow label="通知权限" helper="检测 Pilo 当前的系统通知权限。">
					<div className="flex items-center gap-2">
						<SettingsStatus muted={permission !== "granted"}>
							{checking ? "检测中" : NOTIFICATION_PERMISSION_LABELS[permission]}
						</SettingsStatus>
						<Button
							variant="outline"
							size="sm"
							disabled={checking}
							onClick={() => void refreshPermission()}
						>
							重新检测
						</Button>
					</div>
				</SettingsRow>
				<SettingsRow
					label="启用通知"
					helper="Agent 运行完成或出错时发送系统通知。"
				>
					<Switch
						checked={desktopNotifications}
						onCheckedChange={(enabled) =>
							void handleNotificationsChange(enabled)
						}
					/>
				</SettingsRow>
				<SettingsRow
					label="发送测试通知"
					helper="立即发送一条测试通知；未授权时会先请求系统权限。"
				>
					<Button
						variant="outline"
						size="sm"
						disabled={testing}
						onClick={() => void handleTestNotification()}
					>
						{testing ? "发送中" : "发送测试通知"}
					</Button>
				</SettingsRow>
			</SettingsSection>
			<SettingsSection title="触发时机">
				<SettingsRow
					label="Agent 运行完成"
					helper="点击通知后直接打开对应会话。"
				>
					<SettingsStatus>已启用</SettingsStatus>
				</SettingsRow>
				<SettingsRow
					label="Agent 运行出错"
					helper="运行时错误或 Pi 进程异常时通知。"
				>
					<SettingsStatus>已启用</SettingsStatus>
				</SettingsRow>
			</SettingsSection>
		</div>
	);
}

function AppearanceSettings() {
	const { theme, setTheme } = useTheme();
	const {
		pageFontFamily,
		setPageFontFamily,
		pageCustomFontFamily,
		setPageCustomFontFamily,
		pageFontSize,
		setPageFontSize,
		codeFontFamily,
		setCodeFontFamily,
		codeCustomFontFamily,
		setCodeCustomFontFamily,
		codeFontSize,
		setCodeFontSize,
		terminalFontFamily,
		setTerminalFontFamily,
		terminalCustomFontFamily,
		setTerminalCustomFontFamily,
		terminalFontSize,
		setTerminalFontSize,
	} = usePreferences();

	return (
		<div className="space-y-3">
			<SettingsSection>
				<SettingsRow
					label="主题"
					helper="设置 Pilo 的界面主题，跟随系统时会自动响应操作系统外观变化。"
				>
					<Select
						value={theme}
						onValueChange={(value) => setTheme(value as Theme)}
					>
						<SelectTrigger className="w-[220px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{(Object.keys(THEME_LABELS) as Theme[]).map((value) => (
								<SelectItem key={value} value={value}>
									{THEME_LABELS[value]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>
			</SettingsSection>

			<SettingsSection title="字体">
				<SettingsRow
					label="页面字体"
					helper="用于页面和对话正文。自定义字体可用逗号分隔。"
					alignTop
					className={FONT_SETTINGS_ROW_CLASS}
				>
					<Select
						value={pageFontFamily}
						onValueChange={(value) =>
							setPageFontFamily(value as PageFontFamily)
						}
					>
						<SelectTrigger className="w-[176px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{PAGE_FONT_OPTIONS.map((option) => (
								<SelectItem key={option.value} value={option.value}>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Select
						value={String(pageFontSize)}
						onValueChange={(value) =>
							setPageFontSize(Number(value) as PageFontSize)
						}
					>
						<SelectTrigger className="w-[104px]">
							<SelectValue>{pageFontSize}px</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{PAGE_FONT_SIZES.map((size) => (
								<SelectItem key={size} value={String(size)}>
									<span className="inline-flex items-center gap-2">
										{size}px
										{size === 14 ? (
											<span
												className="size-1.5 rounded-full bg-muted-foreground"
												aria-label="默认字号"
											/>
										) : null}
									</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Input
						value={pageCustomFontFamily}
						onChange={(event) => setPageCustomFontFamily(event.target.value)}
						placeholder="如 Inter, PingFang SC"
						aria-label="自定义页面字体列表"
						className="w-[288px] max-w-full"
					/>
				</SettingsRow>

				<SettingsRow
					label="代码字体"
					helper="用于 Markdown 代码和文件编辑器。自定义字体可用逗号分隔。"
					alignTop
					className={FONT_SETTINGS_ROW_CLASS}
				>
					<Select
						value={codeFontFamily}
						onValueChange={(value) =>
							setCodeFontFamily(value as MonospaceFontFamily)
						}
					>
						<SelectTrigger className="w-[176px] font-mono">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{MONOSPACE_FONT_OPTIONS.map((option) => (
								<SelectItem key={option.value} value={option.value}>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Select
						value={String(codeFontSize)}
						onValueChange={(value) =>
							setCodeFontSize(Number(value) as CodeFontSize)
						}
					>
						<SelectTrigger className="w-[104px]">
							<SelectValue>{codeFontSize}px</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{CODE_FONT_SIZES.map((size) => (
								<SelectItem key={size} value={String(size)}>
									<span className="inline-flex items-center gap-2">
										{size}px
										{size === 12 ? (
											<span
												className="size-1.5 rounded-full bg-muted-foreground"
												aria-label="默认字号"
											/>
										) : null}
									</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Input
						value={codeCustomFontFamily}
						onChange={(event) => setCodeCustomFontFamily(event.target.value)}
						placeholder="如 Maple Mono, Consolas"
						aria-label="自定义代码字体列表"
						className="w-[288px] max-w-full font-mono"
					/>
				</SettingsRow>

				<SettingsRow
					label="终端字体"
					helper="仅影响 Terminal。自定义字体可用逗号分隔。"
					alignTop
					className={FONT_SETTINGS_ROW_CLASS}
				>
					<Select
						value={terminalFontFamily}
						onValueChange={(value) =>
							setTerminalFontFamily(value as MonospaceFontFamily)
						}
					>
						<SelectTrigger className="w-[176px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{MONOSPACE_FONT_OPTIONS.map((option) => (
								<SelectItem key={option.value} value={option.value}>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Select
						value={String(terminalFontSize)}
						onValueChange={(value) =>
							setTerminalFontSize(Number(value) as TerminalFontSize)
						}
					>
						<SelectTrigger className="w-[104px]">
							<SelectValue>{terminalFontSize}px</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{TERMINAL_FONT_SIZES.map((size) => (
								<SelectItem key={size} value={String(size)}>
									<span className="inline-flex items-center gap-2">
										{size}px
										{size === 12 ? (
											<span
												className="size-1.5 rounded-full bg-muted-foreground"
												aria-label="默认字号"
											/>
										) : null}
									</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Input
						value={terminalCustomFontFamily}
						onChange={(event) =>
							setTerminalCustomFontFamily(event.target.value)
						}
						placeholder="如 Maple Mono, Consolas"
						aria-label="自定义终端字体列表"
						className="w-[288px] max-w-full font-mono"
					/>
				</SettingsRow>
			</SettingsSection>
		</div>
	);
}

function ShortcutKeys({ children }: { children: string }) {
	return (
		<span className="inline-flex items-center gap-1 font-mono text-[11px] text-foreground">
			{children.split("+").map((key, index) => (
				<span key={key.trim()} className="flex items-center gap-1">
					{index > 0 ? <span className="text-muted-foreground">+</span> : null}
					<kbd className="min-w-6 rounded border border-border/80 bg-muted/55 px-1.5 py-0.5 text-center shadow-xs">
						{key.trim()}
					</kbd>
				</span>
			))}
		</span>
	);
}

function KeyboardShortcutsSettings() {
	const { sendMessageShortcut } = usePreferences();
	const sendKeys = sendMessageShortcut === "enter" ? "Enter" : "Ctrl/⌘ + Enter";
	const newlineKeys =
		sendMessageShortcut === "enter" ? "Shift + Enter" : "Enter";

	return (
		<div className="space-y-3">
			<SettingsSection title="应用">
				<SettingsRow label="打开设置">
					<ShortcutKeys>Ctrl/⌘ + ,</ShortcutKeys>
				</SettingsRow>
				<SettingsRow label="关闭当前弹层">
					<ShortcutKeys>Esc</ShortcutKeys>
				</SettingsRow>
			</SettingsSection>

			<SettingsSection title="输入框">
				<SettingsRow label="发送消息">
					<ShortcutKeys>{sendKeys}</ShortcutKeys>
				</SettingsRow>
				<SettingsRow label="换行">
					<ShortcutKeys>{newlineKeys}</ShortcutKeys>
				</SettingsRow>
				<SettingsRow
					label="切换输入建议"
					helper="在 @、/、$ 建议列表中移动选择。"
				>
					<div className="flex items-center gap-1.5">
						<ShortcutKeys>↑</ShortcutKeys>
						<span className="text-xs text-muted-foreground">/</span>
						<ShortcutKeys>↓</ShortcutKeys>
					</div>
				</SettingsRow>
				<SettingsRow label="插入选中的建议">
					<ShortcutKeys>Enter</ShortcutKeys>
				</SettingsRow>
			</SettingsSection>

			<SettingsSection title="自定义">
				<SettingsRow
					label="快捷键编辑器"
					helper="后续与 Command Palette 使用同一套命令 ID 和快捷键映射。"
				>
					<SettingsStatus muted>规划中</SettingsStatus>
				</SettingsRow>
			</SettingsSection>
		</div>
	);
}

function AboutSettings() {
	return (
		<div className="space-y-3">
			<SettingsSection>
				<SettingsRow
					label="Pilo"
					helper="Pi-native desktop project for local, WSL, and SSH development."
				>
					<span className="text-xs text-muted-foreground">0.1.0</span>
				</SettingsRow>
				<SettingsRow
					label="运行方式"
					helper="Pilo 负责桌面体验与索引，Pi 负责会话与 Agent runtime。"
				/>
			</SettingsSection>
		</div>
	);
}

export function SettingsDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [activeTab, setActiveTab] = useState<SettingsTabId>("preferences");
	const activeTabConfig =
		SETTINGS_TABS.find((tab) => tab.id === activeTab) ?? SETTINGS_TABS[0];
	const sections = ["个人", "项目", "其他"] as const;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				overlayClassName="bg-black/75"
				className="flex h-[min(90vh,950px)] w-[84vw] max-w-[1100px] flex-col gap-0 overflow-hidden rounded-xl p-0 sm:p-0"
			>
				<DialogDescription className="sr-only">Pilo 设置</DialogDescription>
				<div className="flex min-h-0 flex-1 overflow-hidden">
					<nav
						aria-label="设置"
						className="flex w-60 shrink-0 flex-col border-e bg-background"
					>
						<div className="min-h-0 flex-1 overflow-y-auto p-3 pt-4">
							<div className="space-y-4">
								{sections.map((section) => {
									const tabs = SETTINGS_TABS.filter(
										(tab) => tab.section === section,
									);
									return (
										<section key={section} aria-label={section}>
											<h2 className="px-2.5 pb-1 text-xs font-medium text-muted-foreground/55">
												{section}
											</h2>
											<div className="space-y-0.5">
												{tabs.map((tab) => {
													const Icon = tab.icon;
													return (
														<button
															key={tab.id}
															type="button"
															aria-current={
																activeTab === tab.id ? "page" : undefined
															}
															className={cn(
																"flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-start text-sm font-medium transition-colors",
																activeTab === tab.id
																	? "bg-secondary text-secondary-foreground"
																	: "text-muted-foreground hover:bg-secondary/50 hover:text-secondary-foreground",
															)}
															onClick={() => setActiveTab(tab.id)}
														>
															<Icon
																className="h-4 w-4 shrink-0 opacity-80"
																strokeWidth={1.75}
															/>
															<span className="truncate">{tab.label}</span>
														</button>
													);
												})}
											</div>
										</section>
									);
								})}
							</div>
						</div>
					</nav>

					<main className="flex min-h-0 min-w-0 flex-1 flex-col">
						<header className="mt-2 flex h-12 shrink-0 items-center px-8">
							<DialogTitle className="text-xl font-semibold leading-none">
								{activeTabConfig.label}
							</DialogTitle>
						</header>
						<div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
							<div className="mx-auto max-w-5xl">
								{activeTab === "preferences" ? <PreferencesSettings /> : null}
								{activeTab === "notifications" ? (
									<NotificationSettings />
								) : null}
								{activeTab === "appearance" ? <AppearanceSettings /> : null}
								{activeTab === "shortcuts" ? (
									<KeyboardShortcutsSettings />
								) : null}
								{activeTab === "connections" ? <ConnectionsSettings /> : null}
								{activeTab === "sessions" ? <SessionSettings /> : null}
								{activeTab === "pi" ? <PiSettings /> : null}
								{activeTab === "diagnostics" ? <DiagnosticsSettings /> : null}
								{activeTab === "about" ? <AboutSettings /> : null}
							</div>
						</div>
					</main>
				</div>
			</DialogContent>
		</Dialog>
	);
}
