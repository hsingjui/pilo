import {
	type Accessor,
	Scroll,
	signal,
	Text,
	token,
	View,
	windowSize,
} from "nsh";
import { Dialog } from "nsh/base";

import type { AppState } from "../state/app-state";
import type { NshPiloClient } from "../client/nsh-pilo-client";
import { classNames } from "../ui/class-names";
import { Icon, type IconName } from "../ui/icon";
import { scrollbarLook } from "../ui/scrollbar";
import { styleVar } from "../ui/theme-style";
import { t } from "../app/i18n";
import { AboutPane } from "./about-pane";
import { CacheKeepAlivePane } from "./cache-keep-alive-pane";
import { DesktopPane } from "./desktop-pane";
import { FontsPane } from "./fonts-pane";
import { PendingPane } from "./layout";
import { ModelCatalogPane } from "./model-catalog-pane";
import { NextPromptPane } from "./next-prompt-pane";
import { NotificationsPane } from "./notifications-pane";
import { PromptEnhancementPane } from "./prompt-enhancement-pane";
import { SessionNamingPane } from "./session-naming-pane";
import { PreferencesPane } from "./preferences-pane";
import { ShortcutsPane } from "./shortcuts-pane";
import { ThemePane } from "./theme-pane";

/** The native calls the settings panes make; grows as panes land. */
export type SettingsClient = Pick<
	NshPiloClient,
	| "savePreferences"
	| "saveThemeSettings"
	| "loadConnectionModels"
	| "loadModels"
	| "saveModels"
	| "loadModelScope"
	| "saveModelScope"
	| "loadNamingModels"
	| "saveNamingModel"
	| "loadCacheKeepAliveSettings"
	| "saveCacheKeepAliveSettings"
	| "loadNextPromptSettings"
	| "saveNextPromptSettings"
	| "loadPromptEnhancementSettings"
	| "savePromptEnhancementSettings"
>;

export interface SettingsDialogProps {
	open: () => boolean;
	onClose: () => void;
	/** The app state the panes read (preferences, theme, projects). */
	state: Accessor<AppState>;
	client: SettingsClient;
}

export type SettingsTabId =
	| "preferences"
	| "appearance"
	| "fonts"
	| "notifications"
	| "shortcuts"
	| "connections"
	| "model-catalog"
	| "next-prompt"
	| "prompt-enhancement"
	| "cache-keep-alive"
	| "session-naming"
	| "remote"
	| "desktop"
	| "about";

type SettingsTab = {
	id: SettingsTabId;
	section: "personal" | "project" | "other";
	labelKey: Parameters<typeof t>[0];
	icon: IconName;
};

const SETTINGS_TABS: SettingsTab[] = [
	{
		id: "preferences",
		section: "personal",
		labelKey: "settings.preferences",
		icon: "SlidersHorizontal",
	},
	{
		id: "appearance",
		section: "personal",
		labelKey: "settings.theme",
		icon: "Palette",
	},
	{
		id: "fonts",
		section: "personal",
		labelKey: "settings.font",
		icon: "Type",
	},
	{
		id: "notifications",
		section: "personal",
		labelKey: "settings.notifications",
		icon: "Bell",
	},
	{
		id: "shortcuts",
		section: "personal",
		labelKey: "settings.shortcuts",
		icon: "Keyboard",
	},
	{
		id: "connections",
		section: "project",
		labelKey: "settings.connections",
		icon: "Plug",
	},
	{
		id: "model-catalog",
		section: "project",
		labelKey: "settings.modelCatalog",
		icon: "ListTodo",
	},
	{
		id: "next-prompt",
		section: "project",
		labelKey: "settings.nextPrompt",
		icon: "TextCursorInput",
	},
	{
		id: "prompt-enhancement",
		section: "project",
		labelKey: "settings.promptEnhancement",
		icon: "WandSparkles",
	},
	{
		id: "cache-keep-alive",
		section: "project",
		labelKey: "settings.cacheKeepAlive",
		icon: "Timer",
	},
	{
		id: "session-naming",
		section: "project",
		labelKey: "settings.sessionNaming",
		icon: "Type",
	},
	{
		id: "remote",
		section: "other",
		labelKey: "settings.remote",
		icon: "Server",
	},
	{
		id: "desktop",
		section: "other",
		labelKey: "settings.desktop",
		icon: "Monitor",
	},
	{
		id: "about",
		section: "other",
		labelKey: "settings.about",
		icon: "Info",
	},
];

const SECTIONS = [
	{ id: "personal", labelKey: null },
	{ id: "project", labelKey: "settings.projectSection" },
	{ id: "other", labelKey: "settings.other" },
] as const;

const DIALOG_WIDTH = 880;
const DIALOG_HEIGHT = 600;
const NAV_WIDTH = 192;

/**
 * The settings window: a left navigation of sections and one pane each, as
 * `settings-dialog.tsx` in the Tauri app. Panes read `store.state()` and save
 * through `client`.
 */
export function SettingsDialog(props: SettingsDialogProps) {
	const active = signal<SettingsTabId>("preferences");
	const activeTab = () =>
		SETTINGS_TABS.find((tab) => tab.id === active()) ?? SETTINGS_TABS[0];
	const size = () => ({
		width: Math.min(DIALOG_WIDTH, windowSize().width - 32),
		height: Math.min(DIALOG_HEIGHT, windowSize().height - 64),
	});
	return (
		<Dialog
			testID="settings-dialog"
			open={props.open()}
			animation="fade"
			accessibilityLabel={t("settings.title")}
			onOpenChange={({ open }) => {
				if (!open) props.onClose();
			}}
			class="overflow-hidden rounded-(--pilo-radius-lg) border border-border bg-background text-foreground font-sans self-center my-auto"
			style={[
				{
					...size(),
					boxShadow: styleVar("pilo-shadow-popover"),
					zIndex: token("z-dialog"),
				},
			]}
			backdropClass="bg-black/40"
			backdropStyle={{ zIndex: token("z-dialog-overlay") }}
		>
			<View class="flex-1 flex-row">
				<View
					testID="settings-nav"
					class="shrink-0 border-e border-border bg-background"
					style={{ width: NAV_WIDTH }}
				>
					<Scroll
						class="min-h-0 flex-1"
						contentClass="p-3 gap-4"
						scrollbar={{ mode: "always", vertical: scrollbarLook() }}
					>
						{SECTIONS.map((section) => {
							const tabs = SETTINGS_TABS.filter(
								(tab) => tab.section === section.id,
							);
							return (
								<View class="gap-0.5">
									{section.labelKey ? (
										<Text class="px-2.5 pb-1 text-xs font-medium text-muted-foreground">
											{() => t(section.labelKey ?? "")}
										</Text>
									) : null}
									{tabs.map((tab) => (
										<View
											testID={`settings-nav-${tab.id}`}
											class={classNames(
												"w-full flex-row items-center gap-2.5 rounded-md px-2.5 py-1.5",
												active() === tab.id
													? "bg-secondary"
													: "hover:bg-secondary/50",
											)}
											onPress={() => active.set(tab.id)}
										>
											<Icon
												name={tab.icon}
												size={16}
												class={classNames(
													"shrink-0 opacity-80",
													active() === tab.id
														? "text-secondary-foreground"
														: "text-muted-foreground",
												)}
											/>
											<Text
												class={classNames(
													"flex-1 truncate text-sm font-medium",
													active() === tab.id
														? "text-secondary-foreground"
														: "text-muted-foreground",
												)}
											>
												{() => String(t(tab.labelKey))}
											</Text>
										</View>
									))}
								</View>
							);
						})}
					</Scroll>
				</View>
				<View class="min-w-0 flex-1">
					<View
						testID="settings-header"
						class="mt-2 h-12 shrink-0 flex-row items-center px-6"
					>
						<Text class="text-base font-semibold text-foreground">
							{() => String(t(activeTab().labelKey))}
						</Text>
					</View>
					<Scroll
						class="min-h-0 flex-1"
						contentClass="px-6 pb-6 gap-3"
						scrollbar={{ mode: "always", vertical: scrollbarLook() }}
					>
						{() => {
							switch (active()) {
								case "preferences":
									return (
										<PreferencesPane
											state={props.state}
											client={props.client}
										/>
									);
								case "appearance":
									return (
										<ThemePane state={props.state} client={props.client} />
									);
								case "fonts":
									return (
										<FontsPane state={props.state} client={props.client} />
									);
								case "model-catalog":
									return (
										<ModelCatalogPane
											state={props.state}
											client={props.client}
										/>
									);
								case "next-prompt":
									return (
										<NextPromptPane state={props.state} client={props.client} />
									);
								case "prompt-enhancement":
									return (
										<PromptEnhancementPane
											state={props.state}
											client={props.client}
										/>
									);
								case "cache-keep-alive":
									return (
										<CacheKeepAlivePane
											state={props.state}
											client={props.client}
										/>
									);
								case "session-naming":
									return (
										<SessionNamingPane
											state={props.state}
											client={props.client}
										/>
									);
								case "notifications":
									return (
										<NotificationsPane
											state={props.state}
											client={props.client}
										/>
									);
								case "shortcuts":
									return <ShortcutsPane state={props.state} />;
								case "desktop":
									return <DesktopPane />;
								case "about":
									return <AboutPane />;
								default:
									return (
										<PendingPane detail={String(t("settings.pendingPane"))} />
									);
							}
						}}
					</Scroll>
				</View>
			</View>
		</Dialog>
	);
}
