import {
	Overlay,
	platform,
	Scroll,
	signal,
	split,
	Text,
	token,
	View,
	type Bounds,
} from "nsh";

import type { PiModel, PiThinkingLevel } from "@shared/api/pi-runtime-types";
import { piThinkingLevelLabel } from "@shared/pi-model-selection";
import type {
	ProjectModelScope,
	ProjectScopedModel,
} from "@shared/project-model-scope";

import { t } from "../shell/i18n";
import { PiLogo } from "../shell/pi-logo";
import { chatPx } from "../chat/layout";
import type { ChatRunConfigState } from "../state/chat-run-config";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { classNames } from "../ui/class-names";
import { Menu, menuPopupClass, menuPopupStyle } from "../ui/menu";
import { MenuCheck } from "../ui/menu-check";
import { MenuItem } from "../ui/menu-item";
import { menuRowClass } from "../ui/menu-row";
import { Skeleton } from "../ui/skeleton";
import { Submenu, type SubmenuProps } from "../ui/submenu";
import { composerRunConfigStyle } from "./composer-layout";
import { ComposerModelPicker } from "./composer-model-picker";

const triggerTextStyle = { fontSize: chatPx(12), lineHeight: chatPx(15) };

export interface ComposerRunConfigProps {
	/** The open chat's run configuration; `null` while it opens. */
	config: () => ChatRunConfigState | null;
	/** Every model of the project's catalog. */
	models: () => readonly PiModel[];
	/** The project Scope's effective models, empty until the catalog resolves it. */
	scopeModels: () => readonly PiModel[];
	/** The project's saved Scope; `null` until it is read. */
	scope: () => ProjectModelScope | null;
	/** The catalog resolved every model's Scope membership. */
	scopeReady: () => boolean;
	/** The catalog is still loading. */
	loading: () => boolean;
	/** The last catalog refresh's failure. */
	error: () => string | null;
	/** A Scope save is under way. */
	savingScope: () => boolean;
	onModel: (model: PiModel) => void;
	onThinking: (level: PiThinkingLevel) => void;
	onRefresh?: () => void;
	/** Saves the project Scope; without it the picker cannot edit it. */
	onSaveScope?: (models: ProjectScopedModel[] | null) => Promise<void>;
	/** The session is read-only here, so its model cannot be changed. */
	readOnly?: () => boolean;
}

/** A submenu trigger row: its label and the current value, dimmed. */
function SubTrigger(props: { label: () => string; value: () => string }) {
	return (
		<View class={classNames(menuRowClass, "pr-1.5")}>
			<Text class="min-w-0 flex-1 truncate font-sans">{props.label}</Text>
			<Text class="ml-4 max-w-40 truncate font-sans text-xs text-muted-foreground">
				{props.value}
			</Text>
			<Icon name="ChevronRight" size={14} color={token("muted-foreground")} />
		</View>
	);
}

const useSidePopup = platform.desktop && platform.idiom !== "terminal";

function RunConfigSubmenu(
	props: SubmenuProps & { anchor: () => Bounds | null; sidePopup?: boolean },
) {
	const [local, rest] = split(props, ["anchor", "sidePopup", "children"]);
	return (
		<Submenu {...rest} offset={0}>
			{local.sidePopup ? (
				// Keep the native submenu's navigation and use the main card's bottom edge for placement.
				<Overlay
					anchor={local.anchor()}
					placement="right"
					align="end"
					offset={2}
					class={classNames(menuPopupClass, "max-h-full max-w-full")}
					style={menuPopupStyle()}
				>
					<Scroll class="min-h-0 shrink" bounces={false}>
						{local.children}
					</Scroll>
				</Overlay>
			) : (
				local.children
			)}
		</Submenu>
	);
}

/**
 * The composer toolbar's model · thinking trigger and its menu, as the React
 * composer's `ComposerRunConfig`: Pi's mark, the model's name and the thinking
 * level, a skeleton while they are not known yet.
 */
export function ComposerRunConfig(
	props: ComposerRunConfigProps & {
		toolbarWidth: () => number;
		/** Uses 40px touch target and inline submenus for narrow / mobile web. */
		touch?: boolean;
	},
) {
	const menuBounds = signal<Bounds | null>(null);
	const sidePopup = useSidePopup && !props.touch;
	const selected = () => props.config()?.model ?? null;
	const modelLabel = () => selected()?.name || selected()?.id || "—";
	const thinking = () => props.config()?.thinkingLevel ?? null;
	const thinkingLabel = () => piThinkingLevelLabel(thinking());
	const modelPending = () =>
		!selected() && (props.loading() || !props.config()?.ready);
	const thinkingPending = () =>
		modelPending() || (!thinking() && !props.config()?.ready);
	const triggerStyle = () => {
		const base = composerRunConfigStyle(props.toolbarWidth());
		return props.touch ? { ...base, height: 40 } : base;
	};
	return (
		<Menu
			placement="top"
			align="start"
			offset={8}
			popupClass={sidePopup ? undefined : "min-w-56"}
			// These styles also reach the native submenu shell, which has no in-flow content.
			popupStyle={sidePopup ? { minWidth: 0, padding: 0 } : undefined}
			onPosition={({ bounds }) => menuBounds.set(bounds)}
			onClose={() => menuBounds.set(null)}
			trigger={
				<Button
					testID="run-config-trigger"
					variant="ghost"
					size="sm"
					class="min-w-0 shrink font-normal"
					style={triggerStyle()}
					activeStyle={{ scale: 1 }}
					disabled={!props.config()?.ready || !!props.readOnly?.()}
					accessibilityLabel={t("chat.runConfigLabel", {
						model: modelPending() ? t("chat.loadingModels") : modelLabel(),
						thinking: thinkingPending()
							? t("chat.readingReasoning")
							: thinkingLabel(),
					})}
				>
					<PiLogo size={props.touch ? 16 : chatPx(16)} />
					{() =>
						modelPending() ? (
							<Skeleton
								class="shrink-0 rounded-full"
								style={{ width: chatPx(80), height: chatPx(10) }}
							/>
						) : (
							<>
								<Text
									class="min-w-0 shrink truncate font-sans text-muted-foreground"
									style={triggerTextStyle}
								>
									{modelLabel}
								</Text>
								<Text
									accessible={false}
									accessibilityElementsHidden
									class="shrink-0 font-sans text-muted-foreground/60"
									style={triggerTextStyle}
								>
									·
								</Text>
								{thinkingPending() ? (
									<Skeleton
										class="shrink-0 rounded-full"
										style={{ width: chatPx(32), height: chatPx(10) }}
									/>
								) : (
									<Text
										class="shrink-0 font-sans text-muted-foreground"
										style={triggerTextStyle}
									>
										{thinkingLabel}
									</Text>
								)}
							</>
						)
					}
				</Button>
			}
		>
			<View
				class={classNames(
					"gap-1",
					sidePopup && "min-w-56 p-(--pilo-menu-padding)",
				)}
			>
				<RunConfigSubmenu
					anchor={menuBounds}
					sidePopup={sidePopup}
					trigger={
						<SubTrigger
							label={() => t("chat.model")}
							value={() =>
								props.loading() ? t("chat.loadingModels") : modelLabel()
							}
						/>
					}
				>
					<ComposerModelPicker
						models={props.models}
						scopeModels={props.scopeModels}
						scope={props.scope}
						scopeReady={props.scopeReady}
						selected={selected}
						loading={props.loading}
						error={props.error}
						saving={props.savingScope}
						disabled={() => !props.config()?.ready}
						onSelect={props.onModel}
						onRefresh={props.onRefresh}
						onSaveScope={props.onSaveScope}
					/>
				</RunConfigSubmenu>
				<RunConfigSubmenu
					anchor={menuBounds}
					sidePopup={sidePopup}
					disabled={props.savingScope()}
					trigger={
						<SubTrigger
							label={() => t("chat.reasoning")}
							value={thinkingLabel}
						/>
					}
				>
					<View style={{ gap: Math.max(3, token("pilo-menu-item-gap")) }}>
						{() =>
							(props.config()?.thinkingLevels ?? []).map((level) => (
								<MenuItem
									testID={`run-config-thinking:${level}`}
									role="menuitemradio"
									checked={thinking() === level}
									indicatorClass="hidden"
									class={classNames(
										"min-w-40 justify-between",
										props.touch && "min-h-11",
									)}
									onSelect={() => props.onThinking(level)}
								>
									<Text class="font-sans">{piThinkingLevelLabel(level)}</Text>
									<MenuCheck checked={() => thinking() === level} />
								</MenuItem>
							))
						}
						{() =>
							(props.config()?.thinkingLevels.length ?? 0) === 0 ? (
								<MenuItem disabled>
									<Text class="font-sans text-muted-foreground">
										{() =>
											props.config()?.ready
												? t("chat.noReasoning")
												: t("chat.readingReasoning")
										}
									</Text>
								</MenuItem>
							) : null
						}
					</View>
				</RunConfigSubmenu>
			</View>
		</Menu>
	);
}
