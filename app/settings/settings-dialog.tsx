import {
	type Accessor,
	cleanup,
	createMotion,
	effect,
	reduceMotion,
	Scroll,
	type ScrollRef,
	signal,
	Text,
	token,
	View,
	windowSize,
} from "nsh";
import { Button as BaseButton, Dialog } from "nsh/base";

import { Select } from "../ui/select";

import type { AppState } from "../state/app-state";
import type { NshPiloClient } from "../client/nsh-pilo-client";
import { AppToaster, AppToasts, AppToastStack } from "../shell/app-toasts";
import { classNames } from "../ui/class-names";
import { DialogClose } from "../ui/dialog-close";
import { blurOnPointerPress, focusRingStyle } from "../ui/focus-ring-style";
import { createHover } from "../ui/hover";
import { Icon, type IconName } from "../ui/icon";
import { MOTION, tactileTransition, useMountedDialog } from "../ui/motion";
import { scrollbarLook } from "../ui/scrollbar";
import { styleVar } from "../ui/theme-style";
import type { DesktopNotificationsApi } from "../shell/desktop-notifications";
import type { DesktopShell } from "../shell/desktop-shell";
import type { DesktopUpdate } from "../shell/desktop-update";
import { t } from "../shell/i18n";
import { AboutPane } from "./about-pane";
import { CacheKeepAlivePane } from "./cache-keep-alive-pane";
import { ConnectionsPane } from "./connections-pane";
import { FontsPane } from "./fonts-pane";
import { SETTINGS_SM_WIDTH } from "./layout";
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
	| "loadNamingModels"
	| "saveNamingModel"
	| "loadCacheKeepAliveSettings"
	| "saveCacheKeepAliveSettings"
	| "loadNextPromptSettings"
	| "saveNextPromptSettings"
	| "loadPromptEnhancementSettings"
	| "savePromptEnhancementSettings"
	| "connectEvents"
	| "getLocalConnection"
	| "testLocalConnection"
	| "updateConnectionSettings"
	| "setConnectionShownInHome"
	| "getConnectionHealth"
	| "probeConnectionPi"
	| "listSshConnections"
	| "listSshAgentIdentities"
	| "getSshConnectionPassword"
	| "saveSshConnection"
	| "removeSshConnection"
	| "testSshConnection"
	| "testSshConnectionDraft"
	| "listWslDistributions"
	| "listWslConnections"
	| "saveWslConnection"
	| "removeWslConnection"
	| "testWslConnection"
	| "remoteHostState"
	| "remoteLanAddresses"
	| "remoteSetEnabled"
	| "remoteSetPort"
	| "remoteSetAddresses"
	| "remotePairingRegenerate"
	| "remoteDeviceRevoke"
	| "remoteDeviceRename"
	| "openLogDirectory"
> &
	/** Optional host-only discovery helpers. */
	Partial<
		Pick<
			NshPiloClient,
			"systemFontFamilies" | "listSshConfigHosts" | "listSshLocalKeys"
		>
	>;

export interface SettingsDialogProps {
	open: () => boolean;
	onClose: () => void;
	/** The app state the panes read (preferences, theme, projects). */
	state: Accessor<AppState>;
	client: SettingsClient;
	desktop?: DesktopShell;
	notifications?: DesktopNotificationsApi;
	update?: DesktopUpdate;
}

export type SettingsTabId =
	| "preferences"
	| "appearance"
	| "fonts"
	| "notifications"
	| "shortcuts"
	| "connections"
	| "next-prompt"
	| "prompt-enhancement"
	| "cache-keep-alive"
	| "session-naming"
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
		icon: "Tag",
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
	{ id: "project", labelKey: "settings.connectionsAndAi" },
	{ id: "other", labelKey: "settings.other" },
] as const;

// Tailwind's md:, measured on the window as the WebUI's viewport.
const MD_WIDTH = 768;
const NAV_WIDTH = 216;
const DIALOG_MAX_WIDTH = 1100; // max-w-[1100px]
const DIALOG_MAX_HEIGHT = 950; // min(90dvh, 950px)
const CONTENT_MAX_WIDTH = 1024; // max-w-5xl

/**
 * The settings window: a left navigation of sections and one pane each, as
 * `settings-dialog.tsx` in the WebUI. Panes read `store.state()` and save
 * through `client`.
 */
export function SettingsDialog(props: SettingsDialogProps) {
	const active = signal<SettingsTabId>("preferences");
	const dialog = useMountedDialog(props.open);
	let contentScroll: ScrollRef | undefined;
	const paneMotion = createMotion();
	let lastTab: SettingsTabId = active();
	effect(() => {
		const next = active();
		if (next === lastTab) return;
		lastTab = next;
		contentScroll?.scrollTo({ y: 0, animated: false });
		if (!reduceMotion()) {
			void paneMotion.play({
				keyframes: { opacity: [0.01, 1] },
				duration: MOTION.duration.tactile,
				easing: MOTION.easing.standardTuple,
			});
		}
	});
	cleanup(() => paneMotion.stop());
	const activeTab = () =>
		SETTINGS_TABS.find((tab) => tab.id === active()) ?? SETTINGS_TABS[0];
	const compact = () => windowSize().width < MD_WIDTH;
	const size = () => {
		const win = windowSize();
		return {
			width: Math.min(
				win.width < SETTINGS_SM_WIDTH ? win.width - 32 : win.width * 0.84,
				DIALOG_MAX_WIDTH,
			),
			height: Math.min(win.height * 0.9, DIALOG_MAX_HEIGHT),
		};
	};
	return (
		<Dialog
			testID="settings-dialog"
			open={props.open()}
			animation="fade"
			accessibilityLabel={t("settings.title")}
			onOpenChange={({ open }) => {
				if (!open) props.onClose();
			}}
			onClose={dialog.onClose}
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
			{() => {
				if (!dialog.mounted()) return null;
				const toasts = new AppToasts();
				return (
					<AppToaster.Provider value={toasts}>
						<View class="flex-1 flex-row relative">
							{() =>
								compact() ? null : (
									<View
										testID="settings-nav"
										class="shrink-0 border-e border-border bg-background"
										style={{ width: NAV_WIDTH }}
									>
										<Scroll
											class="min-h-0 flex-1"
											contentClass="p-3 gap-4"
											bounces={false}
											scrollbar={{ mode: "always", vertical: scrollbarLook() }}
										>
											{SECTIONS.map((section) => {
												const tabs = SETTINGS_TABS.filter(
													(tab) => tab.section === section.id,
												);
												return (
													<View>
														{section.labelKey ? (
															<Text class="font-sans px-2.5 pb-1 text-xs text-(length:--pilo-ui-text-xs) font-medium text-muted-foreground">
																{() => t(section.labelKey ?? "")}
															</Text>
														) : null}
														<View class="gap-0.5">
															{tabs.map((tab) => {
																const hover = createHover();
																const pointerBlur = blurOnPointerPress();
																const highlighted = () =>
																	active() === tab.id || hover.hovered();
																// A plain press target, as React's `<button>`: focusable,
																// with a keyboard ring, without Button's press scale.
																return (
																	<BaseButton
																		testID={`settings-nav-${tab.id}`}
																		ref={pointerBlur.ref}
																		onMouseUp={pointerBlur.onMouseUp}
																		class={classNames(
																			"w-full flex-row items-center gap-2.5 rounded-md px-2.5 py-1.5",
																			active() === tab.id
																				? "bg-secondary"
																				: hover.hovered()
																					? "bg-secondary/50"
																					: "bg-transparent",
																		)}
																		style={tactileTransition(
																			"background-color, color",
																		)}
																		focusVisibleStyle={focusRingStyle(
																			token("ring"),
																		)}
																		accessibilityLabel={String(t(tab.labelKey))}
																		{...hover.props}
																		onPress={() => active.set(tab.id)}
																	>
																		<Icon
																			name={tab.icon}
																			size={16}
																			color={token(
																				highlighted()
																					? "secondary-foreground"
																					: "muted-foreground",
																			)}
																			class="shrink-0 opacity-80"
																		/>
																		<Text
																			class={classNames(
																				"flex-1 truncate font-sans text-sm text-(length:--pilo-ui-text-sm) font-medium",
																				highlighted()
																					? "text-secondary-foreground"
																					: "text-muted-foreground",
																			)}
																		>
																			{() => String(t(tab.labelKey))}
																		</Text>
																	</BaseButton>
																);
															})}
														</View>
													</View>
												);
											})}
										</Scroll>
									</View>
								)
							}
							<View class="min-w-0 flex-1">
								<View
									testID="settings-header"
									class={classNames(
										"mt-2 h-12 shrink-0 flex-row items-center",
										compact() ? "px-4 pr-12" : "px-6",
									)}
								>
									{() =>
										compact() ? (
											<Select
												testID="settings-tab-select"
												class="w-full"
												accessibilityLabel={t("settings.title")}
												items={SETTINGS_TABS.map((tab) => ({
													value: tab.id,
													title: String(t(tab.labelKey)),
												}))}
												value={active()}
												onChange={({ value }) => {
													if (value) active.set(value as SettingsTabId);
												}}
											/>
										) : (
											<Text class="font-sans text-lg text-(length:--pilo-ui-text-lg) font-semibold leading-tight tracking-tight text-foreground">
												{() => String(t(activeTab().labelKey))}
											</Text>
										)
									}
								</View>
								<Scroll
									ref={(ref) => {
										contentScroll = ref;
									}}
									class="min-h-0 flex-1"
									contentClass={classNames("pb-6", compact() ? "px-4" : "px-6")}
									bounces={false}
									scrollbar={{ mode: "always", vertical: scrollbarLook() }}
								>
									<View
										class="mx-auto w-full"
										style={[paneMotion.style, { maxWidth: CONTENT_MAX_WIDTH }]}
									>
										{() => {
											switch (active()) {
												case "preferences":
													return (
														<PreferencesPane
															state={props.state}
															client={props.client}
															desktop={props.desktop}
														/>
													);
												case "appearance":
													return (
														<ThemePane
															state={props.state}
															client={props.client}
														/>
													);
												case "fonts":
													return (
														<FontsPane
															state={props.state}
															client={props.client}
														/>
													);
												case "connections":
													return (
														<ConnectionsPane
															state={props.state}
															client={props.client}
														/>
													);
												case "next-prompt":
													return <NextPromptPane client={props.client} />;
												case "prompt-enhancement":
													return (
														<PromptEnhancementPane client={props.client} />
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
															notifications={props.notifications}
														/>
													);
												case "shortcuts":
													return (
														<ShortcutsPane
															state={props.state}
															client={props.client}
															desktop={props.desktop}
														/>
													);
												case "about":
													return (
														<AboutPane
															client={props.client}
															update={props.update}
														/>
													);
											}
										}}
									</View>
								</Scroll>
							</View>
							<DialogClose
								testID="settings-dialog-close"
								accessibilityLabel={t("common.close")}
								onPress={() => props.onClose()}
							/>
							{/* Mount in the settings dialog, above the window-level overlay. */}
							<AppToastStack toasts={toasts} />
						</View>
					</AppToaster.Provider>
				);
			}}
		</Dialog>
	);
}
