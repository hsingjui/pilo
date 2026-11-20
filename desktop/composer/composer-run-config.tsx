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

import type { PiModel, PiThinkingLevel } from "@/lib/api/pi-runtime-types";
import { piThinkingLevelLabel } from "@/lib/pi-model-selection";
import type {
	ProjectModelScope,
	ProjectScopedModel,
} from "@/lib/project-model-scope";

import { t } from "../app/i18n";
import { PiLogo } from "../app/pi-logo";
import type { ChatRunConfigState } from "../state/chat-run-config";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { classNames } from "../ui/class-names";
import { Menu, menuPopupClass, menuPopupStyle } from "../ui/menu";
import { MenuItem } from "../ui/menu-item";
import { menuRowClass } from "../ui/menu-row";
import { Skeleton } from "../ui/skeleton";
import { Submenu, type SubmenuProps } from "../ui/submenu";
import { ComposerModelPicker } from "./composer-model-picker";

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
	props: SubmenuProps & { anchor: () => Bounds | null },
) {
	const [local, rest] = split(props, ["anchor", "children"]);
	return (
		<Submenu {...rest} offset={0}>
			{useSidePopup ? (
				// Keep the native submenu's navigation and use the main card's bottom edge for placement.
				<Overlay
					anchor={local.anchor()}
					placement="right"
					align="end"
					offset={2}
					class={classNames(menuPopupClass, "max-h-full max-w-full")}
					style={menuPopupStyle()}
				>
					<Scroll class="min-h-0 shrink">{local.children}</Scroll>
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
export function ComposerRunConfig(props: ComposerRunConfigProps) {
	const menuBounds = signal<Bounds | null>(null);
	const selected = () => props.config()?.model ?? null;
	const modelLabel = () => selected()?.name || selected()?.id || "—";
	const thinking = () => props.config()?.thinkingLevel ?? null;
	const thinkingLabel = () => piThinkingLevelLabel(thinking());
	const modelPending = () =>
		!selected() && (props.loading() || !props.config()?.ready);
	const thinkingPending = () =>
		modelPending() || (!thinking() && !props.config()?.ready);
	return (
		<Menu
			placement="top"
			align="start"
			offset={8}
			popupClass={useSidePopup ? undefined : "min-w-56"}
			// These styles also reach the native submenu shell, which has no in-flow content.
			popupStyle={useSidePopup ? { minWidth: 0, padding: 0 } : undefined}
			onPosition={({ bounds }) => menuBounds.set(bounds)}
			onClose={() => menuBounds.set(null)}
			trigger={
				<Button
					testID="run-config-trigger"
					variant="ghost"
					size="sm"
					class="-ml-1 h-(--pilo-composer-control-size) min-w-0 shrink gap-1 rounded-(--pilo-radius-md) px-2 text-xs font-normal"
					activeStyle={{ scale: 1 }}
					disabled={!props.config()?.ready}
					accessibilityLabel={t("chat.runConfigLabel", {
						model: modelPending() ? t("chat.loadingModels") : modelLabel(),
						thinking: thinkingPending()
							? t("chat.readingReasoning")
							: thinkingLabel(),
					})}
				>
					<PiLogo size={16} />
					{() =>
						modelPending() ? (
							<Skeleton class="h-2.5 w-20 shrink-0 rounded-full" />
						) : (
							<>
								<Text class="min-w-0 shrink truncate font-sans text-xs leading-4 text-muted-foreground">
									{modelLabel}
								</Text>
								<Text
									accessible={false}
									accessibilityElementsHidden
									class="shrink-0 font-sans text-xs text-muted-foreground/60"
								>
									·
								</Text>
								{thinkingPending() ? (
									<Skeleton class="h-2.5 w-8 shrink-0 rounded-full" />
								) : (
									<Text class="shrink-0 font-sans text-xs leading-4 text-muted-foreground">
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
					useSidePopup && "min-w-56 p-(--pilo-menu-padding)",
				)}
			>
				<RunConfigSubmenu
					anchor={menuBounds}
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
									class="min-w-40 justify-between"
									onSelect={() => props.onThinking(level)}
								>
									<Text class="font-sans">{piThinkingLevelLabel(level)}</Text>
									<View class="size-4 shrink-0 items-center justify-center">
										{() =>
											thinking() === level ? (
												<Icon name="Check" size={14} />
											) : null
										}
									</View>
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
