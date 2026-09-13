import { useState } from "react";
import {
	Activity,
	Info,
	Keyboard,
	MessagesSquare,
	Palette,
	Plug,
	SlidersHorizontal,
	SquareTerminal,
} from "lucide-react";
import { toast } from "sonner";

import { ensureDesktopNotificationPermission } from "@/lib/desktop-notifications";
import {
	usePreferences,
	type ConversationFontSize,
	type SendMessageShortcut,
} from "@/lib/preferences-provider";
import { useTheme, type Theme } from "@/lib/theme-provider";
import { cn } from "@/lib/utils";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
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

const FONT_SIZE_LABELS: Record<ConversationFontSize, string> = {
	13: "小 · 13px",
	14: "默认 · 14px",
	15: "大 · 15px",
	16: "较大 · 16px",
};

function PreferencesSettings() {
	const {
		sendMessageShortcut,
		setSendMessageShortcut,
		collapseCompletedActivity,
		setCollapseCompletedActivity,
		showWorkDuration,
		setShowWorkDuration,
		desktopNotifications,
		setDesktopNotifications,
	} = usePreferences();

	const handleDesktopNotificationsChange = async (enabled: boolean) => {
		if (!enabled) {
			setDesktopNotifications(false);
			return;
		}

		try {
			const granted = await ensureDesktopNotificationPermission();
			setDesktopNotifications(granted);
			if (!granted) {
				toast.error("未能启用桌面通知", {
					description: "请在 Windows 通知设置中允许 Pilo 发送通知。",
				});
			}
		} catch {
			setDesktopNotifications(false);
			toast.error("桌面通知当前不可用");
		}
	};

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
					helper="完成回复时自动收起思考与工具调用列表，减少长会话占用空间。"
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
				<SettingsRow
					label="启用桌面通知"
					helper="当 Pilo 不在前台且 Pi 完成回复时发送系统通知。"
				>
					<Switch
						checked={desktopNotifications}
						onCheckedChange={(enabled) =>
							void handleDesktopNotificationsChange(enabled)
						}
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

function AppearanceSettings() {
	const { theme, setTheme } = useTheme();
	const { conversationFontSize, setConversationFontSize } = usePreferences();

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
				<SettingsRow
					label="对话字号"
					helper="调整用户消息和 Pi 回复正文的字号，不影响代码与工具详情。"
				>
					<Select
						value={String(conversationFontSize)}
						onValueChange={(value) =>
							setConversationFontSize(Number(value) as ConversationFontSize)
						}
					>
						<SelectTrigger className="w-[220px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{(
								Object.keys(
									FONT_SIZE_LABELS,
								) as unknown as ConversationFontSize[]
							).map((value) => (
								<SelectItem key={value} value={String(value)}>
									{FONT_SIZE_LABELS[value]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>
			</SettingsSection>

			<SettingsSection title="终端">
				<SettingsRow
					label="终端字体与字号"
					helper="Terminal 接入后提供独立的等宽字体、字号和显示设置。"
				>
					<SettingsStatus muted>Terminal 接入后开放</SettingsStatus>
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
