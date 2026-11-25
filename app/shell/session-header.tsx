import { computed, type JSX, signal, Text, token, View } from "nsh";
import { Button as BaseButton } from "nsh/base";

import { fileBasename } from "@shared/chat/chat-tool-result";
import type { WorkspaceFile } from "@shared/project-workspace";
import {
	computeMaxVisibleAuxTabs,
	partitionHeaderTabs,
	workspaceFileIconKind,
	type WorkspaceFileIconKind,
} from "@shared/project-workspace-tabs";
import type { TerminalTab } from "../state/terminal-store";

import { AppToaster, showToast } from "./app-toasts";
import { PiLogo } from "./pi-logo";
import { Button } from "../ui/button";
import { classNames } from "../ui/class-names";
import { writeClipboardText } from "../ui/clipboard";
import { Dialog } from "../ui/dialog";
import { DialogDescription } from "../ui/dialog-description";
import { DialogFooter } from "../ui/dialog-footer";
import { DialogHeader } from "../ui/dialog-header";
import { DialogTitle } from "../ui/dialog-title";
import { blurOnPointerPress, focusRingStyle } from "../ui/focus-ring-style";
import { createHover } from "../ui/hover";
import { Icon, type IconName } from "../ui/icon";
import { Input } from "../ui/input";
import { Menu } from "../ui/menu";
import { MenuItem } from "../ui/menu-item";
import { MenuSeparator } from "../ui/menu-separator";
import { Tooltip } from "../ui/tooltip";
import { t } from "./i18n";

export interface SessionHeaderProps {
	/** The session's title (runtime name, else the index entry's). */
	title: () => string;
	/** Pi's session id, for the copy action; `null` until it reports one. */
	sessionId: () => string | null;
	/** The session's file path; `null` while it is unsaved. */
	sessionPath: () => string | null;
	/** Renames the session in the index; omitted for an unsaved one. */
	onRename?: (title: string) => void;
	/** The sidebar is collapsed: its expand button floats over the logo. */
	logoHidden?: () => boolean;
	/** The chat's title tab and menu show; a new chat's landing hides them. */
	showTitle: () => boolean;
	/** The chat is temporary: a dashed tab, and no session menu. */
	temporary: () => boolean;
	/** The project's Git workspace tab beside the chat's. */
	git?: {
		open: () => boolean;
		active: () => boolean;
		onSelect: () => void;
		onClose: () => void;
	};
	/** The project's open file preview tabs beside the chat's. */
	files?: {
		tabs: () => readonly WorkspaceFile[];
		/** The file in front of the chat; `null` while the chat or a terminal is. */
		activePath: () => string | null;
		onSelect: (path: string) => void;
		onClose: (path: string) => void;
	};
	/** Brings the chat tab back in front of any open file or terminal tab. */
	onSelectChat?: () => void;
	/** The project's terminal tabs beside the chat's. */
	terminals?: {
		tabs: () => TerminalTab[];
		/** The terminal in front of the chat; `null` while the chat is. */
		activeId: () => string | null;
		onSelect: (terminalId: string | null) => void;
		onClose: (terminalId: string) => void;
	};
	/** The buttons before the session menu (terminal, temporary chat, quick open). */
	actions?: JSX.Element;
}

const FILE_ICON_MAP: Record<WorkspaceFileIconKind, IconName> = {
	text: "FileText",
	json: "FileJson2",
	config: "FileCog",
	terminal: "SquareTerminal",
	style: "Palette",
	file: "File",
	code: "FileCode2",
};

interface AuxTabItem {
	id: string;
	testID: string;
	closeTestID: string;
	icon: IconName;
	label: () => string;
	tooltip: () => string;
	tooltipMono?: boolean;
	closeLabel: () => string;
	onSelect: () => void;
	onClose: () => void;
}

/**
 * The open session's part of the main title bar: its title tab, the
 * project's file and terminal tabs, the actions and the menu. It fills the bar
 * beside the window controls, as the React header does on its draggable top row.
 */
export function SessionHeader(props: SessionHeaderProps) {
	const stripWidth = signal(0);
	const gitOpen = () => props.git?.open() ?? false;
	const gitActive = () => props.git?.active() ?? false;
	const fileTabs = () => props.files?.tabs() ?? [];
	const terminalTabs = () => props.terminals?.tabs() ?? [];
	const auxTabs = computed<AuxTabItem[]>(() => {
		const items: AuxTabItem[] = [];
		if (gitOpen()) {
			items.push({
				id: "git",
				testID: "git-tab",
				closeTestID: "git-tab-close",
				icon: "GitBranch",
				label: () => "Git",
				tooltip: () => t("file.viewChanges"),
				closeLabel: () => t("file.closeFile", { name: "Git" }),
				onSelect: () => props.git?.onSelect(),
				onClose: () => props.git?.onClose(),
			});
		}
		for (const file of fileTabs()) {
			const name = fileBasename(file.path) || file.path;
			items.push({
				id: `file:${file.path}`,
				testID: `file-tab:${file.path}`,
				closeTestID: `file-tab-close:${file.path}`,
				icon: FILE_ICON_MAP[workspaceFileIconKind(file.path)],
				label: () => name,
				tooltip: () => file.path,
				tooltipMono: true,
				closeLabel: () => t("file.closeFile", { name }),
				onSelect: () => props.files?.onSelect(file.path),
				onClose: () => props.files?.onClose(file.path),
			});
		}
		for (const tab of terminalTabs()) {
			const label = () =>
				`${tab.title} ${tab.number}${tab.exited ? " · exited" : ""}`;
			items.push({
				id: `terminal:${tab.id}`,
				testID: `terminal-tab:${tab.id}`,
				closeTestID: `terminal-tab-close:${tab.id}`,
				icon: "SquareTerminal",
				label,
				tooltip: label,
				closeLabel: () => t("terminal.close"),
				onSelect: () => props.terminals?.onSelect(tab.id),
				onClose: () => props.terminals?.onClose(tab.id),
			});
		}
		return items;
	});
	const hasTabs = computed(() => auxTabs().length > 0);
	const activeAuxId = computed<string | null>(() => {
		if (gitActive()) return "git";
		const activeFile = props.files?.activePath() ?? null;
		if (activeFile !== null) return `file:${activeFile}`;
		const activeTerminal = props.terminals?.activeId() ?? null;
		if (activeTerminal !== null) return `terminal:${activeTerminal}`;
		return null;
	});
	const chatSelected = computed(() => activeAuxId() === null);
	const maxVisible = computed(() =>
		computeMaxVisibleAuxTabs(stripWidth(), props.showTitle() || hasTabs()),
	);
	const partitioned = computed(() =>
		partitionHeaderTabs(auxTabs(), activeAuxId(), maxVisible()),
	);
	const hasOverflow = computed(() => partitioned().overflow.length > 0);
	return (
		<View
			testID="main-header"
			class="h-full min-w-0 flex-1 flex-row items-center gap-2"
		>
			<View
				class="min-w-0 flex-1 flex-row items-center gap-1"
				onLayout={({ bounds }) => stripWidth.set(bounds.size.width)}
			>
				{() => {
					if (!props.showTitle() && !hasTabs()) return null;
					const tooltip = (
						<Tooltip>
							<Text class="font-sans">{() => props.title()}</Text>
						</Tooltip>
					);
					const content = (
						<>
							{() =>
								props.temporary() ? (
									<Icon
										name="MessageSquareDashed"
										size={14}
										color={token(
											chatSelected() ? "foreground" : "muted-foreground",
										)}
									/>
								) : (
									<View
										class="transition-opacity duration-200"
										style={{
											opacity: props.logoHidden?.()
												? 0
												: chatSelected()
													? 0.75
													: 0.45,
										}}
									>
										<PiLogo size={15} />
									</View>
								)
							}
							<Text
								testID="session-header-title"
								class={classNames(
									"min-w-0 shrink truncate font-sans text-sm text-(length:--pilo-ui-text-sm)",
									chatSelected()
										? hasTabs()
											? "font-medium text-foreground"
											: "text-foreground"
										: "text-muted-foreground",
								)}
							>
								{() => props.title()}
							</Text>
						</>
					);
					const tabClass = (extra: string | false) =>
						classNames(
							"h-7 min-w-0 flex-row items-center gap-1.5 rounded-(--pilo-radius-md) border px-2 transition-colors",
							extra,
						);
					// Beside auxiliary tabs the title becomes a matching ghost tab.
					if (hasTabs()) {
						const pointerBlur = blurOnPointerPress();
						return (
							<BaseButton
								testID="session-header"
								ref={pointerBlur.ref}
								onMouseUp={pointerBlur.onMouseUp}
								class={tabClass(
									classNames(
										"min-w-20 max-w-48 focus-visible:outline-hidden",
										props.temporary()
											? chatSelected()
												? "border-dashed border-border bg-secondary"
												: "border-dashed border-border/70 hover:bg-hover/70"
											: chatSelected()
												? "border-border/70 bg-secondary"
												: "border-transparent hover:bg-hover/70",
									),
								)}
								focusVisibleStyle={focusRingStyle(token("ring"))}
								role="tab"
								selected={chatSelected()}
								accessibilityLabel={props.title()}
								tooltip={tooltip}
								onPress={() => {
									if (props.onSelectChat) props.onSelectChat();
									else props.terminals?.onSelect(null);
								}}
							>
								{content}
							</BaseButton>
						);
					}
					return (
						<View
							testID="session-header"
							class={tabClass(
								classNames(
									"max-w-[66.666667%]",
									props.temporary()
										? "border-dashed border-border"
										: "border-transparent",
								),
							)}
							tooltip={tooltip}
						>
							{content}
						</View>
					);
				}}
				{() =>
					hasTabs() ? (
						<View
							testID="workspace-tabs-divider"
							class="mx-0.5 h-3.5 w-px shrink-0 bg-border/80"
						/>
					) : null
				}
				<Each of={partitioned().visible} key={(tab) => tab.id}>
					{(tab) => (
						<WorkspaceHeaderTab
							tab={tab()}
							selected={() => activeAuxId() === tab().id}
						/>
					)}
				</Each>
				{() =>
					hasOverflow() ? (
						<OverflowTabsMenu items={() => partitioned().overflow} />
					) : null
				}
			</View>
			<View class="shrink-0 flex-row items-center gap-1 pr-2">
				{props.actions}
				{() =>
					props.showTitle() && !props.temporary() ? (
						<SessionHeaderMenu
							sessionId={props.sessionId}
							sessionPath={props.sessionPath}
							title={props.title}
							onRename={props.onRename}
						/>
					) : null
				}
			</View>
		</View>
	);
}

/** A ghost workspace tab (Git, file preview or terminal) with hover-revealed close. */
function WorkspaceHeaderTab(props: {
	tab: AuxTabItem;
	selected: () => boolean;
}) {
	const hover = createHover();
	const active = () => props.selected();
	const showClose = () => active() || hover.hovered();
	const pointerBlur = blurOnPointerPress();
	return (
		<View
			testID={props.tab.testID}
			{...hover.props}
			onMouseUp={({ button }) => {
				if (button === "middle") props.tab.onClose();
			}}
			class={classNames(
				"h-7 max-w-44 shrink-0 flex-row items-center rounded-(--pilo-radius-md) border transition-colors",
				active()
					? "border-border/70 bg-secondary"
					: "border-transparent hover:bg-hover/70",
			)}
		>
			<BaseButton
				ref={pointerBlur.ref}
				onMouseUp={pointerBlur.onMouseUp}
				class="h-full min-w-0 flex-1 flex-row items-center gap-1.5 pl-2 pr-0.5 focus-visible:outline-hidden"
				focusVisibleStyle={focusRingStyle(token("ring"))}
				role="tab"
				selected={active()}
				accessibilityLabel={props.tab.label()}
				tooltip={
					<Tooltip>
						<Text
							class={
								props.tab.tooltipMono
									? "font-mono text-xs text-(length:--pilo-ui-text-xs)"
									: "font-sans"
							}
						>
							{props.tab.tooltip}
						</Text>
					</Tooltip>
				}
				onPress={props.tab.onSelect}
			>
				<Icon
					name={props.tab.icon}
					size={14}
					color={token(
						active() || hover.hovered() ? "foreground" : "muted-foreground",
					)}
				/>
				<Text
					class={classNames(
						"min-w-0 shrink truncate font-sans text-sm text-(length:--pilo-ui-text-sm)",
						active()
							? "font-medium text-foreground"
							: hover.hovered()
								? "text-foreground"
								: "text-muted-foreground",
					)}
				>
					{props.tab.label}
				</Text>
			</BaseButton>
			<Button
				testID={props.tab.closeTestID}
				variant="ghost"
				size="icon"
				class={classNames(
					"mr-0.5 size-5 shrink-0 rounded-sm transition-opacity",
					showClose() ? "opacity-100" : "opacity-0",
				)}
				accessibilityLabel={props.tab.closeLabel()}
				onPress={props.tab.onClose}
			>
				<Icon name="X" size={12} color={token("muted-foreground")} />
			</Button>
		</View>
	);
}

/** Collapses auxiliary tabs that exceed the title bar's inline budget into a compact menu. */
function OverflowTabsMenu(props: { items: () => readonly AuxTabItem[] }) {
	const count = () => props.items().length;
	const label = () => t("file.moreTabs", { count: count() });
	return (
		<Menu
			align="start"
			popupClass="w-60"
			trigger={
				<Button
					testID="workspace-tabs-overflow"
					variant="ghost"
					size="sm"
					class="h-7 shrink-0 gap-1 rounded-(--pilo-radius-md) border border-border/60 px-2 text-xs text-(length:--pilo-ui-text-xs) text-muted-foreground hover:bg-hover/70 hover:text-foreground"
					accessibilityLabel={label()}
					tooltip={
						<Tooltip>
							<Text class="font-sans">{label}</Text>
						</Tooltip>
					}
				>
					<Text class="font-mono text-xs text-(length:--pilo-ui-text-xs) text-muted-foreground">
						{() => `+${count()}`}
					</Text>
					<Icon
						name="ChevronDown"
						size={12}
						color={token("muted-foreground")}
					/>
				</Button>
			}
		>
			<View class="gap-0.5">
				<Each of={props.items()} key={(item) => item.id}>
					{(item) => (
						<MenuItem
							testID={`overflow-tab:${item().id}`}
							indicatorClass="hidden"
							icon={<Icon name={item().icon} size={14} />}
							onSelect={() => item().onSelect()}
						>
							<Text class="min-w-0 flex-1 truncate font-sans text-sm text-(length:--pilo-ui-text-sm)">
								{() => item().label()}
							</Text>
						</MenuItem>
					)}
				</Each>
			</View>
		</Menu>
	);
}

/** The ⋯ menu: copy id/path and rename, as the WebUI header's. */
function SessionHeaderMenu(props: {
	sessionId: () => string | null;
	sessionPath: () => string | null;
	title: () => string;
	onRename?: (title: string) => void;
}) {
	const renameOpen = signal(false);
	const toasts = AppToaster();
	const copy = (text: string) =>
		void writeClipboardText(text)
			.then(() =>
				showToast(toasts, { variant: "success", title: t("chat.copied") }),
			)
			.catch(() =>
				showToast(toasts, { variant: "error", title: t("chat.copyFailed") }),
			);
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
						tooltip={
							<Tooltip>
								<Text class="font-sans">{() => t("chat.sessionMenu")}</Text>
							</Tooltip>
						}
					>
						<Icon name="MoreHorizontal" size={16} />
					</Button>
				}
			>
				<View class="gap-1">
					<MenuItem
						testID="session-menu-copy-id"
						indicatorClass="hidden"
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
						<Text class="min-w-0 flex-1 truncate text-right font-mono text-xs text-(length:--pilo-ui-text-xs)">
							{() => props.sessionId() ?? "—"}
						</Text>
					</MenuItem>
					<MenuItem
						testID="session-menu-copy-path"
						indicatorClass="hidden"
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
						<Text class="min-w-0 flex-1 truncate text-right font-mono text-xs text-(length:--pilo-ui-text-xs)">
							{() => props.sessionPath() ?? t("chat.sessionPathUnavailable")}
						</Text>
					</MenuItem>
					{props.onRename ? (
						<>
							<MenuSeparator />
							<MenuItem
								testID="session-menu-rename"
								indicatorClass="hidden"
								icon={<Icon name="Pencil" size={14} />}
								onSelect={() => renameOpen.set(true)}
							>
								<Text class="font-sans">{() => t("chat.renameSession")}</Text>
							</MenuItem>
						</>
					) : null}
				</View>
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
					<Text class="font-sans">{() => t("chat.renameDialogCancel")}</Text>
				</Button>
				<Button
					testID="session-rename-confirm"
					disabled={
						value().trim().length === 0 || value().trim() === props.title()
					}
					onPress={submit}
				>
					<Text class="font-sans">{() => t("chat.renameDialogConfirm")}</Text>
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
