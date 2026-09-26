import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	Bell,
	Info,
	Keyboard,
	Palette,
	Plug,
	SlidersHorizontal,
	Type,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
	ScrollArea,
} from "@/ui";
import { AboutSettings } from "./about-settings";
import { AppearanceSettings } from "./appearance-settings";
import { ConnectionsSettings } from "./connections-settings";
import { KeyboardShortcutsSettings } from "./keyboard-shortcuts-settings";
import { NotificationSettings } from "./notification-settings";
import { PreferencesSettings } from "./preferences-settings";
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
