import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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

import { changeAppLocale, isAppLocale } from "@/i18n";
import {
	ensureDesktopNotificationPermission,
	getDesktopNotificationPermission,
	isDesktopNotificationPermissionSystemManaged,
	sendDesktopNotificationTest,
	type DesktopNotificationPermission,
} from "@/lib/desktop-notifications";
import {
	CODE_FONT_SIZES,
	MONOSPACE_FONT_BUILTIN_OPTIONS,
	PAGE_FONT_BUILTIN_OPTIONS,
	PAGE_FONT_SIZES,
	TERMINAL_FONT_SIZES,
	buildSystemFontOptions,
	filterSymbolFontFamilies,
	resolveSystemFontFamilies,
	resolveSystemMonospaceFamilies,
	type CodeFontSize,
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
import { FontSelect, type FontSelectGroup } from "./font-select";
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
		section: "personal",
		labelKey: "settings.preferences",
		icon: SlidersHorizontal,
	},
	{
		id: "appearance" as const,
		section: "personal",
		labelKey: "settings.appearance",
		icon: Palette,
	},
	{
		id: "notifications" as const,
		section: "personal",
		labelKey: "settings.notifications",
		icon: Bell,
	},
	{
		id: "shortcuts" as const,
		section: "personal",
		labelKey: "settings.shortcuts",
		icon: Keyboard,
	},
	{
		id: "connections" as const,
		section: "project",
		labelKey: "settings.connections",
		icon: Plug,
	},
	{
		id: "session-naming" as const,
		section: "project",
		labelKey: "settings.sessionNaming",
		icon: Type,
	},
	{
		id: "about" as const,
		section: "other",
		labelKey: "settings.about",
		icon: Info,
	},
] as const;

const THEME_LABEL_KEYS: Record<
	Theme,
	"settings.light" | "settings.dark" | "settings.system"
> = {
	light: "settings.light",
	dark: "settings.dark",
	system: "settings.system",
};

const FONT_SETTINGS_ROW_CLASS = "sm:grid-cols-[160px_1fr]";

function PreferencesSettings() {
	const { t, i18n } = useTranslation();
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
			<SettingsSection title={t("settings.conversation")}>
				<SettingsRow label={t("settings.sendShortcut")}>
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
							<SelectItem value="enter">Enter</SelectItem>
							<SelectItem value="mod-enter">Ctrl/⌘ + Enter</SelectItem>
						</SelectContent>
					</Select>
				</SettingsRow>
				<SettingsRow label={t("settings.collapseLongMessages")}>
					<Switch
						checked={collapseLongMessages}
						onCheckedChange={setCollapseLongMessages}
					/>
				</SettingsRow>
				<SettingsRow label={t("settings.collapseWork")}>
					<Switch
						checked={collapseCompletedActivity}
						onCheckedChange={setCollapseCompletedActivity}
					/>
				</SettingsRow>
				<SettingsRow label={t("settings.language")}>
					<Select
						value={i18n.language === "zh-CN" ? "zh-CN" : "en-US"}
						onValueChange={(value) => {
							if (isAppLocale(value)) void changeAppLocale(value);
						}}
					>
						<SelectTrigger className={cn(SETTINGS_CONTROL_CLASS, "w-[180px]")}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="zh-CN">
								{t("settings.languageChinese")}
							</SelectItem>
							<SelectItem value="en-US">
								{t("settings.languageEnglish")}
							</SelectItem>
						</SelectContent>
					</Select>
				</SettingsRow>
			</SettingsSection>
		</div>
	);
}

const NOTIFICATION_PERMISSION_KEYS: Record<
	DesktopNotificationPermission,
	| "settings.granted"
	| "settings.denied"
	| "settings.notRequested"
	| "settings.unavailable"
> = {
	granted: "settings.granted",
	denied: "settings.denied",
	default: "settings.notRequested",
	unsupported: "settings.unavailable",
};

function NotificationSettings() {
	const { t } = useTranslation();
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
			toast.error(t("settings.enableNotificationsFailed"), {
				description: t("settings.allowNotificationsDescription"),
			});
		}
	};

	const handleTestNotification = async () => {
		setTesting(true);
		const sent = await sendDesktopNotificationTest();
		setPermission(await getDesktopNotificationPermission());
		setTesting(false);
		if (!sent)
			toast.error(t("settings.testNotificationFailed"), {
				description: t("settings.checkNotificationPermission"),
			});
	};

	return (
		<div className={SETTINGS_CONTAINER_CLASS}>
			<SettingsSection title={t("settings.systemNotifications")}>
				<SettingsRow label={t("settings.sendDesktopNotifications")}>
					<Switch
						checked={desktopNotifications}
						onCheckedChange={(enabled) =>
							void handleNotificationsChange(enabled)
						}
					/>
				</SettingsRow>

				<SettingsRow label={t("settings.notificationPermission")}>
					<div className="flex items-center gap-1.5">
						<SettingsStatus
							muted={permission !== "granted" && !permissionSystemManaged}
						>
							{checking
								? t("settings.testing")
								: permissionSystemManaged
									? t("settings.systemManaged")
									: t(NOTIFICATION_PERMISSION_KEYS[permission])}
						</SettingsStatus>
						{!permissionSystemManaged ? (
							<Hint
								label={checking ? undefined : t("settings.recheckPermission")}
							>
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

				<SettingsRow label={t("settings.testNotification")}>
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
						{testing
							? t("settings.sending")
							: t("settings.sendTestNotification")}
					</Button>
				</SettingsRow>
			</SettingsSection>
		</div>
	);
}

function AppearanceSettings() {
	const { t } = useTranslation();
	const { theme, setTheme } = useTheme();
	const {
		pageFontFamily,
		setPageFontFamily,
		pageFontSize,
		setPageFontSize,
		codeFontFamily,
		setCodeFontFamily,
		codeFontSize,
		setCodeFontSize,
		terminalFontFamily,
		setTerminalFontFamily,
		terminalFontSize,
		setTerminalFontSize,
	} = usePreferences();
	const [systemPageFonts, setSystemPageFonts] = useState<readonly string[]>([]);
	const [systemMonospaceFonts, setSystemMonospaceFonts] = useState<
		readonly string[]
	>([]);

	useEffect(() => {
		let cancelled = false;
		void resolveSystemFontFamilies().then((families) => {
			if (!cancelled) setSystemPageFonts(filterSymbolFontFamilies(families));
		});
		void resolveSystemMonospaceFamilies().then((families) => {
			if (!cancelled) setSystemMonospaceFonts(families);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const pageFontGroups: FontSelectGroup[] = [
		{ label: t("settings.builtIn"), options: PAGE_FONT_BUILTIN_OPTIONS },
		{
			label: t("settings.systemFonts"),
			options: buildSystemFontOptions(systemPageFonts),
		},
	];
	const monospaceFontGroups: FontSelectGroup[] = [
		{ label: t("settings.builtIn"), options: MONOSPACE_FONT_BUILTIN_OPTIONS },
		{
			label: t("settings.systemMonospace"),
			options: buildSystemFontOptions(systemMonospaceFonts),
		},
	];

	return (
		<div className={SETTINGS_CONTAINER_CLASS}>
			<SettingsSection>
				<SettingsRow label={t("settings.theme")}>
					<Select
						value={theme}
						onValueChange={(value) => setTheme(value as Theme)}
					>
						<SelectTrigger className={cn(SETTINGS_CONTROL_CLASS, "w-[220px]")}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{(Object.keys(THEME_LABEL_KEYS) as Theme[]).map((value) => (
								<SelectItem key={value} value={value}>
									{t(THEME_LABEL_KEYS[value])}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>
			</SettingsSection>

			<SettingsSection title={t("settings.font")}>
				<SettingsRow
					label={t("settings.pageFont")}
					className={FONT_SETTINGS_ROW_CLASS}
				>
					<FontSelect
						value={pageFontFamily}
						groups={pageFontGroups}
						onChange={setPageFontFamily}
					/>
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
												aria-label={t("settings.defaultFontSize")}
											/>
										) : null}
									</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>

				<SettingsRow
					label={t("settings.codeFont")}
					className={FONT_SETTINGS_ROW_CLASS}
				>
					<FontSelect
						value={codeFontFamily}
						groups={monospaceFontGroups}
						onChange={setCodeFontFamily}
						className="font-mono"
					/>
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
												aria-label={t("settings.defaultFontSize")}
											/>
										) : null}
									</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>

				<SettingsRow
					label={t("settings.terminalFont")}
					className={FONT_SETTINGS_ROW_CLASS}
				>
					<FontSelect
						value={terminalFontFamily}
						groups={monospaceFontGroups}
						onChange={setTerminalFontFamily}
					/>
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
												aria-label={t("settings.defaultFontSize")}
											/>
										) : null}
									</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
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
	const { t } = useTranslation();
	const [activeTab, setActiveTab] = useState<SettingsTabId>("preferences");
	const activeTabConfig =
		SETTINGS_TABS.find((tab) => tab.id === activeTab) ?? SETTINGS_TABS[0];
	const sections = [
		{ id: "personal", labelKey: null },
		{ id: "project", labelKey: "settings.projectSection" },
		{ id: "other", labelKey: "settings.other" },
	] as const;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex h-[min(90vh,950px)] w-[84vw] max-w-[1100px] flex-col gap-0 overflow-hidden p-0 sm:p-0">
				<DialogDescription className="sr-only">
					{t("settings.title")}
				</DialogDescription>
				<div className="flex min-h-0 flex-1 overflow-hidden">
					<nav
						aria-label={t("settings.title")}
						className="flex w-48 shrink-0 flex-col border-e bg-background"
					>
						<div className="min-h-0 flex-1 overflow-y-auto p-3">
							<div className="space-y-4">
								{sections.map((section) => {
									const tabs = SETTINGS_TABS.filter(
										(tab) => tab.section === section.id,
									);
									return (
										<section
											key={section.id}
											aria-label={
												section.labelKey
													? t(section.labelKey)
													: t("settings.personal")
											}
										>
											{section.labelKey ? (
												<h2 className="px-2.5 pb-1 text-xs font-medium text-muted-foreground">
													{t(section.labelKey)}
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
															<span className="truncate">
																{t(tab.labelKey)}
															</span>
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
							<DialogTitle>{t(activeTabConfig.labelKey)}</DialogTitle>
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
