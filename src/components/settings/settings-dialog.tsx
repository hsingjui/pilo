import { useEffect, useState } from "react";
import {
	Bell,
	Info,
	Keyboard,
	Palette,
	Plug,
	RefreshCw,
	Send,
	SlidersHorizontal,
	Type,
} from "lucide-react";
import { toast } from "sonner";

import {
	ensureDesktopNotificationPermission,
	getDesktopNotificationPermission,
	isDesktopNotificationPermissionSystemManaged,
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
	ScrollArea,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Switch,
	Hint,
} from "@/ui";
import {
	SETTINGS_CONTAINER_CLASS,
	SETTINGS_CONTROL_CLASS,
	SETTINGS_ICON_BUTTON_CLASS,
	SETTINGS_TEXT_BUTTON_CLASS,
	SettingsRow,
	SettingsSection,
	SettingsStatus,
} from "./compact-layout";
import { AboutSettings } from "./about-settings";
import { ConnectionsSettings } from "./connections-settings";
import { KeyboardShortcutsSettings } from "./keyboard-shortcuts-settings";
import { SessionNamingSettings } from "./session-naming-settings";

type SettingsTabId =
	| "preferences"
	| "notifications"
	| "appearance"
	| "shortcuts"
	| "connections"
	| "session-naming"
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
		id: "session-naming" as const,
		section: "项目",
		label: "会话命名",
		icon: Type,
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

const FONT_SETTINGS_ROW_CLASS = "sm:grid-cols-[160px_1fr]";

function PreferencesSettings() {
	const {
		sendMessageShortcut,
		setSendMessageShortcut,
		collapseCompletedActivity,
		setCollapseCompletedActivity,
		collapseLongMessages,
		setCollapseLongMessages,
	} = usePreferences();

	return (
		<div className={SETTINGS_CONTAINER_CLASS}>
			<SettingsSection title="对话">
				<SettingsRow label="发送消息">
					<Select
						value={sendMessageShortcut}
						onValueChange={(value) =>
							setSendMessageShortcut(value as SendMessageShortcut)
						}
					>
						<SelectTrigger className={cn(SETTINGS_CONTROL_CLASS, "w-[180px]")}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="enter">Enter 发送</SelectItem>
							<SelectItem value="mod-enter">Ctrl/⌘ + Enter 发送</SelectItem>
						</SelectContent>
					</Select>
				</SettingsRow>
				<SettingsRow
					label="折叠超长消息"
					helper={`超过 ${8_000} 字符的消息默认只显示开头。`}
				>
					<Switch
						checked={collapseLongMessages}
						onCheckedChange={setCollapseLongMessages}
					/>
				</SettingsRow>
				<SettingsRow
					label="折叠完成的工作过程"
					helper="回答结束后把思考与工具调用收起成一行摘要。"
				>
					<Switch
						checked={collapseCompletedActivity}
						onCheckedChange={setCollapseCompletedActivity}
					/>
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
	const permissionSystemManaged =
		isDesktopNotificationPermissionSystemManaged();
	const [permission, setPermission] = useState<DesktopNotificationPermission>(
		permissionSystemManaged ? "granted" : "default",
	);
	const [checking, setChecking] = useState(!permissionSystemManaged);
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
		if (permissionSystemManaged) return;

		let active = true;
		void getDesktopNotificationPermission().then((next) => {
			if (!active) return;
			setPermission(next);
			setChecking(false);
		});
		return () => {
			active = false;
		};
	}, [permissionSystemManaged]);

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
		if (!sent)
			toast.error("测试通知发送失败", {
				description: "请检查系统通知权限后重试。",
			});
	};

	return (
		<div className={SETTINGS_CONTAINER_CLASS}>
			<SettingsSection
				title="系统通知"
				description="Agent 完成或运行出错时发送提醒。"
			>
				<SettingsRow label="桌面通知">
					<Switch
						checked={desktopNotifications}
						onCheckedChange={(enabled) =>
							void handleNotificationsChange(enabled)
						}
					/>
				</SettingsRow>

				<SettingsRow
					label="系统权限"
					helper={
						permission === "denied"
							? "系统已拒绝通知权限，请在系统设置中允许 Pilo 发送通知。"
							: undefined
					}
				>
					<div className="flex items-center gap-1.5">
						<SettingsStatus
							muted={permission !== "granted" && !permissionSystemManaged}
						>
							{checking
								? "检测中…"
								: permissionSystemManaged
									? "系统管理"
									: NOTIFICATION_PERMISSION_LABELS[permission]}
						</SettingsStatus>
						{!permissionSystemManaged ? (
							<Hint label={checking ? undefined : "重新检测通知权限"}>
								<Button
									variant="ghost"
									size="icon"
									className={SETTINGS_ICON_BUTTON_CLASS}
									disabled={checking}
									onClick={() => void refreshPermission()}
								>
									<RefreshCw
										className={cn("size-3.5", checking && "animate-spin")}
									/>
								</Button>
							</Hint>
						) : null}
					</div>
				</SettingsRow>

				<SettingsRow label="测试通知">
					<Button
						variant="ghost"
						size="sm"
						className={cn(
							SETTINGS_TEXT_BUTTON_CLASS,
							"text-muted-foreground hover:text-foreground",
						)}
						disabled={testing}
						onClick={() => void handleTestNotification()}
					>
						<Send className="size-3.5" />
						{testing ? "发送中…" : "发送测试通知"}
					</Button>
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
		<div className={SETTINGS_CONTAINER_CLASS}>
			<SettingsSection>
				<SettingsRow label="主题">
					<Select
						value={theme}
						onValueChange={(value) => setTheme(value as Theme)}
					>
						<SelectTrigger className={cn(SETTINGS_CONTROL_CLASS, "w-[220px]")}>
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
				<SettingsRow label="页面字体" className={FONT_SETTINGS_ROW_CLASS}>
					<Select
						value={pageFontFamily}
						onValueChange={(value) =>
							setPageFontFamily(value as PageFontFamily)
						}
					>
						<SelectTrigger className={cn(SETTINGS_CONTROL_CLASS, "w-[176px]")}>
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
						<SelectTrigger className={cn(SETTINGS_CONTROL_CLASS, "w-[104px]")}>
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
						className={cn(SETTINGS_CONTROL_CLASS, "w-[288px] max-w-full")}
					/>
				</SettingsRow>

				<SettingsRow label="代码字体" className={FONT_SETTINGS_ROW_CLASS}>
					<Select
						value={codeFontFamily}
						onValueChange={(value) =>
							setCodeFontFamily(value as MonospaceFontFamily)
						}
					>
						<SelectTrigger
							className={cn(SETTINGS_CONTROL_CLASS, "w-[176px] font-mono")}
						>
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
						<SelectTrigger className={cn(SETTINGS_CONTROL_CLASS, "w-[104px]")}>
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
						className={cn(
							SETTINGS_CONTROL_CLASS,
							"w-[288px] max-w-full font-mono",
						)}
					/>
				</SettingsRow>

				<SettingsRow label="终端字体" className={FONT_SETTINGS_ROW_CLASS}>
					<Select
						value={terminalFontFamily}
						onValueChange={(value) =>
							setTerminalFontFamily(value as MonospaceFontFamily)
						}
					>
						<SelectTrigger className={cn(SETTINGS_CONTROL_CLASS, "w-[176px]")}>
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
						<SelectTrigger className={cn(SETTINGS_CONTROL_CLASS, "w-[104px]")}>
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
						className={cn(
							SETTINGS_CONTROL_CLASS,
							"w-[288px] max-w-full font-mono",
						)}
					/>
				</SettingsRow>
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
	const sections = [
		{ id: "个人", label: null },
		{ id: "项目", label: "项目" },
		{ id: "其他", label: "其他" },
	] as const;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex h-[min(90vh,950px)] w-[84vw] max-w-[1100px] flex-col gap-0 overflow-hidden p-0 sm:p-0">
				<DialogDescription className="sr-only">Pilo 设置</DialogDescription>
				<div className="flex min-h-0 flex-1 overflow-hidden">
					<nav
						aria-label="设置"
						className="flex w-48 shrink-0 flex-col border-e bg-background"
					>
						<div className="min-h-0 flex-1 overflow-y-auto p-3">
							<div className="space-y-4">
								{sections.map((section) => {
									const tabs = SETTINGS_TABS.filter(
										(tab) => tab.section === section.id,
									);
									return (
										<section key={section.id} aria-label={section.id}>
											{section.label ? (
												<h2 className="px-2.5 pb-1 text-xs font-medium text-muted-foreground">
													{section.label}
												</h2>
											) : null}
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
															<Icon className="h-4 w-4 shrink-0 opacity-80" />
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
							<DialogTitle>{activeTabConfig.label}</DialogTitle>
						</header>
						<div className="min-h-0 flex-1">
							<ScrollArea className="h-full">
								<div className="px-6 pb-6">
									<div className="mx-auto max-w-5xl">
										{activeTab === "preferences" ? (
											<PreferencesSettings />
										) : null}
										{activeTab === "notifications" ? (
											<NotificationSettings />
										) : null}
										{activeTab === "appearance" ? <AppearanceSettings /> : null}
										{activeTab === "shortcuts" ? (
											<KeyboardShortcutsSettings />
										) : null}
										{activeTab === "connections" ? (
											<ConnectionsSettings />
										) : null}
										{activeTab === "session-naming" ? (
											<SessionNamingSettings />
										) : null}
										{activeTab === "about" ? <AboutSettings /> : null}
									</div>
								</div>
							</ScrollArea>
						</div>
					</main>
				</div>
			</DialogContent>
		</Dialog>
	);
}
