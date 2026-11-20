import { Clipboard, signal, Text, View } from "nsh";

import { PiLogo } from "./pi-logo";
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
}

const copyFailed = () => console.warn("Failed to copy to the clipboard");
const copy = (text: string) => void Clipboard.writeText(text).catch(copyFailed);

/**
 * The open session's part of the main title bar: its title tab and the
 * menu. It fills the bar beside the window controls, as the React
 * header does on its draggable top row.
 */
export function SessionHeader(props: SessionHeaderProps) {
	return (
		<View
			testID="session-header"
			class="h-full min-w-0 flex-1 flex-row items-center"
		>
			<View class="min-w-0 flex-1 flex-row items-center">
				<View
					class="min-h-8 min-w-0 max-w-[66.666667%] flex-row items-center gap-1.5 rounded-(--pilo-radius-md) px-2"
					tooltip={
						<Tooltip>
							<Text class="font-sans">{() => props.title()}</Text>
						</Tooltip>
					}
				>
					<View
						class="transition-opacity duration-200"
						style={{ opacity: props.logoHidden?.() ? 0 : 0.6 }}
					>
						<PiLogo size={16} />
					</View>
					<Text
						testID="session-header-title"
						class="min-w-0 shrink truncate font-sans text-sm text-foreground"
					>
						{() => props.title()}
					</Text>
				</View>
			</View>
			<View class="shrink-0 flex-row items-center gap-1 pr-2">
				<SessionHeaderMenu
					sessionId={props.sessionId}
					sessionPath={props.sessionPath}
					title={props.title}
					onRename={props.onRename}
				/>
			</View>
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
	return (
		<>
			<Menu
				align="end"
				popupClass="max-w-64"
				popupStyle={{ minWidth: 0 }}
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
