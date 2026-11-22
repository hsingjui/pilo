import { Clipboard, type JSX, signal, Text, token, View } from "nsh";
import { Button as BaseButton } from "nsh/base";

import { fileBasename } from "@shared/chat/chat-tool-result";
import type { WorkspaceFile } from "@shared/project-workspace";
import type { TerminalTab } from "../state/terminal-store";

import { AppToaster, showToast } from "./app-toasts";
import { PiLogo } from "./pi-logo";
import { Button } from "../ui/button";
import { classNames } from "../ui/class-names";
import { Dialog } from "../ui/dialog";
import { DialogDescription } from "../ui/dialog-description";
import { DialogFooter } from "../ui/dialog-footer";
import { DialogHeader } from "../ui/dialog-header";
import { DialogTitle } from "../ui/dialog-title";
import { focusRingStyle } from "../ui/focus-ring-style";
import { Icon } from "../ui/icon";
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

/**
 * The open session's part of the main title bar: its title tab, the
 * project's file and terminal tabs, the actions and the menu. It fills the bar
 * beside the window controls, as the React header does on its draggable top row.
 */
export function SessionHeader(props: SessionHeaderProps) {
	const fileTabs = () => props.files?.tabs() ?? [];
	const terminalTabs = () => props.terminals?.tabs() ?? [];
	const hasTabs = () => fileTabs().length > 0 || terminalTabs().length > 0;
	const chatSelected = () =>
		(props.files?.activePath() ?? null) === null &&
		(props.terminals?.activeId() ?? null) === null;
	return (
		<View
			testID="main-header"
			class="h-full min-w-0 flex-1 flex-row items-center"
		>
			<View class="min-w-0 flex-1 flex-row items-center gap-1">
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
									<Icon name="MessageSquareDashed" size={16} />
								) : (
									<View
										class="transition-opacity duration-200"
										style={{ opacity: props.logoHidden?.() ? 0 : 0.6 }}
									>
										<PiLogo size={16} />
									</View>
								)
							}
							<Text
								testID="session-header-title"
								class={classNames(
									"min-w-0 shrink truncate font-sans text-sm",
									chatSelected() ? "text-foreground" : "text-muted-foreground",
								)}
							>
								{() => props.title()}
							</Text>
						</>
					);
					const tabClass = (extra: string | false) =>
						classNames(
							"min-h-8 min-w-0 flex-row items-center gap-1.5 rounded-(--pilo-radius-md) border px-2",
							props.temporary()
								? "border-dashed border-border"
								: "border-transparent",
							extra,
						);
					// Beside terminal tabs the title is a tab that brings the chat back.
					return hasTabs() ? (
						<BaseButton
							testID="session-header"
							class={tabClass(
								classNames(
									"min-w-24 max-w-56 focus-visible:outline-hidden",
									chatSelected() ? "bg-muted/60" : "hover:bg-hover",
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
					) : (
						<View
							testID="session-header"
							class={tabClass("max-w-[66.666667%]")}
							tooltip={tooltip}
						>
							{content}
						</View>
					);
				}}
				{() =>
					fileTabs().map((file) => (
						<FileHeaderTab
							file={file}
							selected={() => props.files?.activePath() === file.path}
							onSelect={() => props.files?.onSelect(file.path)}
							onClose={() => props.files?.onClose(file.path)}
						/>
					))
				}
				{() =>
					terminalTabs().map((tab) => (
						<TerminalHeaderTab
							tab={tab}
							selected={() => props.terminals?.activeId() === tab.id}
							onSelect={() => props.terminals?.onSelect(tab.id)}
							onClose={() => props.terminals?.onClose(tab.id)}
						/>
					))
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

type FileIconName =
	| "FileText"
	| "FileJson2"
	| "FileCog"
	| "SquareTerminal"
	| "Palette"
	| "File"
	| "FileCode2";

function workspaceFileIconName(path: string): FileIconName {
	const name = fileBasename(path).toLowerCase();
	if (
		/\.(?:md|markdown|txt|log)$/.test(name) ||
		/^(?:readme|license)$/.test(name)
	)
		return "FileText";
	if (/\.(?:json|jsonc|json5)$/.test(name)) return "FileJson2";
	if (
		/\.(?:ya?ml|toml|ini|conf|cfg)$/.test(name) ||
		/^\.env(?:\.|$)/.test(name) ||
		/^(?:\.gitignore|\.dockerignore)$/.test(name)
	)
		return "FileCog";
	if (
		/\.(?:sh|bash|zsh|fish|ps1|psm1|bat|cmd)$/.test(name) ||
		/^(?:dockerfile|makefile)$/.test(name)
	)
		return "SquareTerminal";
	if (/\.(?:css|scss|sass|less)$/.test(name)) return "Palette";
	if (!name.includes(".")) return "File";
	return "FileCode2";
}

/** A file preview's tab: its type icon, filename, path tooltip and close button. */
function FileHeaderTab(props: {
	file: WorkspaceFile;
	selected: () => boolean;
	onSelect: () => void;
	onClose: () => void;
}) {
	const name = fileBasename(props.file.path) || props.file.path;
	const iconName = workspaceFileIconName(props.file.path);
	return (
		<View
			testID={`file-tab:${props.file.path}`}
			class={classNames(
				"min-w-28 max-w-56 flex-row items-center rounded-(--pilo-radius-md) border hover:bg-hover",
				props.selected() ? "border-border bg-muted/60" : "border-border/60",
			)}
		>
			<BaseButton
				class="min-h-8 min-w-0 flex-1 flex-row items-center gap-1.5 pl-2.5 pr-1 focus-visible:outline-hidden"
				focusVisibleStyle={focusRingStyle(token("ring"))}
				role="tab"
				selected={props.selected()}
				accessibilityLabel={name}
				tooltip={
					<Tooltip>
						<Text class="font-mono text-xs">{props.file.path}</Text>
					</Tooltip>
				}
				onPress={props.onSelect}
			>
				<Icon
					name={iconName}
					size={16}
					color={token(props.selected() ? "foreground" : "muted-foreground")}
				/>
				<Text
					class={classNames(
						"min-w-0 shrink truncate font-sans text-sm",
						props.selected() ? "text-foreground" : "text-muted-foreground",
					)}
				>
					{name}
				</Text>
			</BaseButton>
			<Button
				testID={`file-tab-close:${props.file.path}`}
				variant="ghost"
				size="icon"
				class="mr-1 size-6"
				accessibilityLabel={t("file.closeFile", { name })}
				onPress={props.onClose}
			>
				<Icon name="X" size={14} color={token("muted-foreground")} />
			</Button>
		</View>
	);
}

/** A terminal's tab: its shell's title, and a button that closes it. */
function TerminalHeaderTab(props: {
	tab: TerminalTab;
	selected: () => boolean;
	onSelect: () => void;
	onClose: () => void;
}) {
	const label = () =>
		`${props.tab.title} ${props.tab.number}${props.tab.exited ? " · exited" : ""}`;
	return (
		<View
			testID={`terminal-tab:${props.tab.id}`}
			class={classNames(
				"min-w-28 max-w-56 flex-row items-center rounded-(--pilo-radius-md) border hover:bg-hover",
				props.selected() ? "border-border bg-muted/60" : "border-border/60",
			)}
		>
			<BaseButton
				class="min-h-8 min-w-0 flex-1 flex-row items-center gap-1.5 pl-2.5 pr-1 focus-visible:outline-hidden"
				focusVisibleStyle={focusRingStyle(token("ring"))}
				role="tab"
				selected={props.selected()}
				accessibilityLabel={label()}
				tooltip={
					<Tooltip>
						<Text class="font-sans">{label}</Text>
					</Tooltip>
				}
				onPress={props.onSelect}
			>
				<Icon
					name="SquareTerminal"
					size={16}
					color={token(props.selected() ? "foreground" : "muted-foreground")}
				/>
				<Text
					class={classNames(
						"min-w-0 shrink truncate font-sans text-sm",
						props.selected() ? "text-foreground" : "text-muted-foreground",
					)}
				>
					{label}
				</Text>
			</BaseButton>
			<Button
				testID={`terminal-tab-close:${props.tab.id}`}
				variant="ghost"
				size="icon"
				class="mr-1 size-6"
				accessibilityLabel={t("terminal.close")}
				onPress={props.onClose}
			>
				<Icon name="X" size={14} color={token("muted-foreground")} />
			</Button>
		</View>
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
	const toasts = AppToaster();
	const copy = (text: string) =>
		void Clipboard.writeText(text)
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
						<Text class="min-w-0 flex-1 truncate text-right font-mono text-xs">
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
						<Text class="min-w-0 flex-1 truncate text-right font-mono text-xs">
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
