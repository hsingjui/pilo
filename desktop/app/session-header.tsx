import { Clipboard, type JSX, signal, Text, token, View } from "nsh";

import type { PiModel, PiThinkingLevel } from "@/lib/api/pi-runtime-types";
import type { ChatSessionRuntimeState } from "@/lib/chat/session-stats";
import { piThinkingLevelLabel } from "@/lib/pi-model-selection";
import type { ChatRunConfigState } from "../state/chat-run-config";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { DialogDescription } from "../ui/dialog-description";
import { DialogFooter } from "../ui/dialog-footer";
import { DialogHeader } from "../ui/dialog-header";
import { DialogTitle } from "../ui/dialog-title";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { Menu } from "../ui/menu";
import { MenuItem } from "../ui/menu-item";
import { MenuSeparator } from "../ui/menu-separator";
import { Spinner } from "../ui/spinner";
import { Submenu } from "../ui/submenu";
import { Tooltip } from "../ui/tooltip";
import { t } from "./i18n";

export interface SessionHeaderProps {
	/** The session's title (runtime name, else the index entry's). */
	title: () => string;
	/** Pi's session id, for the copy action; `null` until it reports one. */
	sessionId: () => string | null;
	/** The session's file path; `null` while it is unsaved. */
	sessionPath: () => string | null;
	/** Pi is compacting the context. */
	compacting: () => boolean;
	/** The session's usage overlay; `null` until the first stats reply. */
	usage: () => ChatSessionRuntimeState | null;
	/** The open chat's run configuration; `null` while it opens. */
	runConfig: () => ChatRunConfigState | null;
	/** The project's model list for the picker. */
	models: () => readonly PiModel[];
	/** The catalog is still loading. */
	modelsLoading: () => boolean;
	onModel: (model: PiModel) => void;
	onThinking: (level: PiThinkingLevel) => void;
	onRefreshModels?: () => void;
	/** Renames the session in the index; omitted for an unsaved one. */
	onRename?: (title: string) => void;
}

const copyFailed = () => console.warn("Failed to copy to the clipboard");
const copy = (text: string) => void Clipboard.writeText(text).catch(copyFailed);

/** The row above the chat: title, run config, context usage and the menu. */
export function SessionHeader(props: SessionHeaderProps) {
	const config = () => props.runConfig();
	const modelLabel = () => config()?.model?.name || config()?.model?.id || "—";
	const thinkingLabel = () =>
		piThinkingLevelLabel(config()?.thinkingLevel ?? null);
	const usagePercent = () => props.usage()?.contextPercent;
	const usageLabel = () =>
		usagePercent() == null ? "—" : `${Math.round(usagePercent()!)}%`;
	return (
		<View
			testID="session-header"
			class="h-11 shrink-0 flex-row items-center gap-1 border-b border-border bg-background pl-3 pr-2"
		>
			<Text
				testID="session-header-title"
				class="min-w-0 flex-1 truncate font-sans text-sm font-medium text-foreground"
			>
				{() => props.title()}
			</Text>
			{() =>
				props.compacting() ? (
					<View
						testID="session-header-compacting"
						class="flex-row items-center gap-1.5 px-2"
					>
						<Spinner size={13} color={token("muted-foreground")} />
						<Text class="font-sans text-xs text-muted-foreground">
							{() => t("chat.compacting")}
						</Text>
					</View>
				) : null
			}
			<View
				testID="session-header-usage"
				class="flex-row items-center px-2"
				tooltip={
					<Tooltip>
						<Text>
							{() =>
								usagePercent() == null
									? t("chat.contextUsageUnknown")
									: props.usage()?.contextStale
										? t("chat.contextUsageKnownPending")
										: t("chat.contextUsage", { percent: usageLabel() })
							}
						</Text>
					</Tooltip>
				}
			>
				<Text class="font-sans text-xs text-muted-foreground">
					{usageLabel}
				</Text>
			</View>
			<RunConfigMenu
				config={config}
				models={props.models}
				loading={props.modelsLoading}
				trigger={
					<Button
						testID="run-config-trigger"
						variant="ghost"
						size="sm"
						disabled={!config()?.ready}
						accessibilityLabel={t("chat.runConfigLabel", {
							model: modelLabel(),
							thinking: thinkingLabel(),
						})}
					>
						<Text class="max-w-40 truncate font-sans text-xs">
							{modelLabel}
						</Text>
						<Text class="font-sans text-xs text-muted-foreground/60">·</Text>
						<Text class="font-sans text-xs">{thinkingLabel}</Text>
					</Button>
				}
				onModel={props.onModel}
				onThinking={props.onThinking}
				onRefresh={props.onRefreshModels}
			/>
			<SessionHeaderMenu
				sessionId={props.sessionId}
				sessionPath={props.sessionPath}
				title={props.title}
				onRename={props.onRename}
			/>
		</View>
	);
}

/** A submenu trigger row: its label and the current value, dimmed. */
function SubTrigger(props: { label: () => string; value: () => string }) {
	return (
		<View class="min-w-0 flex-1 flex-row items-center justify-between gap-4">
			<Text class="min-w-0 flex-1 truncate font-sans">{props.label}</Text>
			<Text class="max-w-40 truncate font-sans text-xs text-muted-foreground">
				{props.value}
			</Text>
			<Icon name="ChevronRight" size={14} color={token("muted-foreground")} />
		</View>
	);
}

function RunConfigMenu(props: {
	config: () => ChatRunConfigState | null;
	models: () => readonly PiModel[];
	loading: () => boolean;
	trigger: JSX.Element;
	onModel: (model: PiModel) => void;
	onThinking: (level: PiThinkingLevel) => void;
	onRefresh?: () => void;
}) {
	const selected = () => props.config()?.model;
	const modelLabel = () => selected()?.name || selected()?.id || "—";
	const thinking = () => props.config()?.thinkingLevel;
	return (
		<Menu trigger={props.trigger} align="end" popupClass="min-w-56">
			<Submenu
				trigger={
					<SubTrigger
						label={() => t("chat.model")}
						value={() =>
							props.loading() ? t("chat.loadingModels") : modelLabel()
						}
					/>
				}
			>
				{() =>
					props.models().map((model) => (
						<MenuItem
							testID={`run-config-model:${model.provider}:${model.id}`}
							role="menuitemradio"
							checked={
								selected()?.provider === model.provider &&
								selected()?.id === model.id
							}
							onSelect={() => props.onModel(model)}
						>
							<Text class="min-w-0 flex-1 truncate font-sans">
								{model.name || model.id}
							</Text>
						</MenuItem>
					))
				}
				{() =>
					!props.loading() && props.models().length === 0 ? (
						<MenuItem disabled>
							<Text class="font-sans text-muted-foreground">
								{() => t("chat.noModels")}
							</Text>
						</MenuItem>
					) : null
				}
				{props.onRefresh ? (
					<>
						<MenuSeparator />
						<MenuItem
							testID="run-config-refresh"
							icon={<Icon name="RefreshCw" size={14} />}
							onSelect={() => props.onRefresh?.()}
						>
							<Text class="font-sans">{() => t("chat.refreshModels")}</Text>
						</MenuItem>
					</>
				) : null}
			</Submenu>
			<Submenu
				disabled={(props.config()?.thinkingLevels.length ?? 0) === 0}
				trigger={
					<SubTrigger
						label={() => t("chat.reasoning")}
						value={() => piThinkingLevelLabel(thinking() ?? null)}
					/>
				}
			>
				{() =>
					(props.config()?.thinkingLevels ?? []).map((level) => (
						<MenuItem
							testID={`run-config-thinking:${level}`}
							role="menuitemradio"
							checked={thinking() === level}
							onSelect={() => props.onThinking(level)}
						>
							<Text class="font-sans">{piThinkingLevelLabel(level)}</Text>
						</MenuItem>
					))
				}
			</Submenu>
		</Menu>
	);
}

/** The ⋯ menu: copy id/path and rename, as the Tauri header's. */
function SessionHeaderMenu(props: {
	sessionId: () => string | null;
	sessionPath: () => string | null;
	title: () => string;
	onRename?: (title: string) => void;
}) {
	const renameOpen = signal(false);
	return (
		<>
			<Menu
				align="end"
				popupClass="w-72"
				trigger={
					<Button
						testID="session-menu-trigger"
						variant="ghost"
						size="icon"
						class="size-7"
						accessibilityLabel={t("chat.sessionMenu")}
					>
						<Icon name="MoreHorizontal" size={16} />
					</Button>
				}
			>
				<MenuItem
					testID="session-menu-copy-id"
					icon={<Icon name="Copy" size={14} />}
					disabled={!props.sessionId()}
					onSelect={() => {
						const id = props.sessionId();
						if (id) copy(id);
					}}
				>
					<Text class="shrink-0 font-sans text-muted-foreground">
						{() => t("chat.sessionId")}
					</Text>
					<Text class="min-w-0 flex-1 truncate text-right font-mono text-xs">
						{() => props.sessionId() ?? "—"}
					</Text>
				</MenuItem>
				<MenuItem
					testID="session-menu-copy-path"
					icon={<Icon name="Copy" size={14} />}
					disabled={!props.sessionPath()}
					onSelect={() => {
						const path = props.sessionPath();
						if (path) copy(path);
					}}
				>
					<Text class="shrink-0 font-sans text-muted-foreground">
						{() => t("chat.sessionFilePath")}
					</Text>
					<Text class="min-w-0 flex-1 truncate text-right font-mono text-xs">
						{() => props.sessionPath() ?? t("chat.sessionPathUnavailable")}
					</Text>
				</MenuItem>
				{props.onRename ? (
					<>
						<MenuSeparator />
						<MenuItem
							testID="session-menu-rename"
							icon={<Icon name="Pencil" size={14} />}
							onSelect={() => renameOpen.set(true)}
						>
							<Text class="font-sans">{() => t("chat.renameSession")}</Text>
						</MenuItem>
					</>
				) : null}
			</Menu>
			{props.onRename ? <RenameDialog open={renameOpen} {...props} /> : null}
		</>
	);
}

function RenameDialog(props: {
	open: { (): boolean; set: (value: boolean) => void };
	title: () => string;
	onRename?: (title: string) => void;
}) {
	const value = signal("");
	const submit = () => {
		const title = value().trim();
		if (title && title !== props.title()) props.onRename?.(title);
		props.open.set(false);
	};
	return (
		<Dialog
			testID="session-rename-dialog"
			open={props.open()}
			accessibilityLabel={t("chat.renameDialogTitle")}
			onOpenChange={({ open }) => props.open.set(open)}
			onOpen={() => value.set(props.title())}
		>
			<DialogHeader>
				<DialogTitle>{() => t("chat.renameDialogTitle")}</DialogTitle>
				<DialogDescription>
					{() => t("chat.renameDialogDescription")}
				</DialogDescription>
			</DialogHeader>
			<Input
				testID="session-rename-input"
				placeholder={t("navigation.renamePlaceholder")}
				accessibilityLabel={t("chat.renameDialogTitle")}
				value={value()}
				onChange={(event) => value.set(event.value)}
				onSubmit={submit}
			/>
			<DialogFooter>
				<Button variant="ghost" onPress={() => props.open.set(false)}>
					<Text>{() => t("chat.renameDialogCancel")}</Text>
				</Button>
				<Button
					testID="session-rename-confirm"
					disabled={
						value().trim().length === 0 || value().trim() === props.title()
					}
					onPress={submit}
				>
					<Text>{() => t("chat.renameDialogConfirm")}</Text>
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
