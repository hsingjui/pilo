import { type Accessor, type Bounds, signal, Text, token, View } from "nsh";
import { Button, ContextMenu } from "nsh/base";

import type { SidebarSession } from "@/components/sidebar/types";
import type { AppStore } from "../state/app-store";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { Menu, menuPopupClass, menuPopupStyle } from "../ui/menu";
import { MenuItem } from "../ui/menu-item";
import { Tooltip } from "../ui/tooltip";
import { t } from "./i18n";
import { createHover, HOVER_ACTION, sidebarFocusRing } from "./sidebar-parts";
import { SessionGlideContext } from "./sidebar-session-glide";

/**
 * The delete button at a session row's end: a first press asks to confirm,
 * which resets after 3.5 s or when the pointer leaves.
 */
function ConfirmDeleteButton(props: {
	testID: string;
	class: string;
	onConfirm: () => void;
}) {
	const confirming = signal(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const reset = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		confirming.set(false);
	};
	const hover = createHover();
	return (
		<Button
			testID={props.testID}
			class={`${props.class} ${
				confirming()
					? "z-10 h-6 min-w-10 flex-row items-center justify-center overflow-hidden rounded-full border border-destructive/20 bg-sidebar-background px-2"
					: "size-6 items-center justify-center rounded-sm transition-opacity duration-100"
			}`}
			style={confirming() ? { width: "max-content" } : undefined}
			focusVisibleStyle={sidebarFocusRing()}
			accessibilityLabel={
				confirming() ? t("sidebar.confirmDelete") : t("sidebar.delete")
			}
			onMouseEnter={hover.props.onMouseEnter}
			onMouseLeave={() => {
				hover.props.onMouseLeave();
				if (confirming()) reset();
			}}
			onPress={() => {
				if (!confirming()) {
					if (timer !== undefined) clearTimeout(timer);
					confirming.set(true);
					timer = setTimeout(() => {
						timer = undefined;
						confirming.set(false);
					}, 3500);
					return;
				}
				reset();
				props.onConfirm();
			}}
		>
			{() =>
				confirming() ? (
					<>
						<View class="pointer-events-none absolute inset-0 rounded-full bg-destructive/12 dark:bg-destructive/35" />
						<Text class="shrink-0 whitespace-nowrap font-sans text-[11px] font-medium leading-none text-destructive">
							{() => t("sidebar.confirmDelete")}
						</Text>
					</>
				) : (
					<Icon
						name="Trash2"
						size={14}
						color={token(
							hover.hovered()
								? "sidebar-foreground"
								: "sidebar-foreground-muted",
						)}
					/>
				)
			}
		</Button>
	);
}

export function SessionRow(props: {
	store: AppStore;
	session: Accessor<SidebarSession>;
	/** The session's project, for a list that mixes projects. */
	projectName?: Accessor<string | undefined>;
}) {
	const { store } = props;
	const session = props.session;
	const glide = SessionGlideContext();
	let bounds: Bounds | null = null;
	const menuOpen = signal(false);
	const contextOpen = signal(false);
	const confirmingDelete = signal(false);
	const renaming = signal(false);
	const renameValue = signal("");
	const menuHover = createHover();
	const selected = () => {
		const open = store.state().navigation.session;
		return (
			open?.projectId === session().projectId &&
			open.sessionPath === session().sessionPath
		);
	};
	const projectContext = () => Boolean(props.projectName?.());

	const submitRename = () => {
		if (!renaming()) return;
		const title = renameValue().trim();
		renaming.set(false);
		if (title && title !== session().title) {
			void store.renameSession(
				session().projectId,
				session().sessionPath,
				title,
			);
		}
	};

	const deleteSession = () =>
		void store.deleteSession(session().projectId, session().sessionPath);

	/** The menu's delete is a two-step confirm: the item stays open once. */
	const confirmDelete = () => {
		if (!confirmingDelete()) {
			confirmingDelete.set(true);
			return;
		}
		confirmingDelete.set(false);
		menuOpen.set(false);
		contextOpen.set(false);
		deleteSession();
	};

	const menuItems = () => (
		<View class="gap-1">
			<MenuItem
				testID={`session:${session().id}:rename`}
				indicatorClass="hidden"
				icon={<Icon name="Pencil" size={14} />}
				onSelect={() => {
					renameValue.set(session().title);
					renaming.set(true);
				}}
			>
				<Text class="font-sans">{() => t("sidebar.rename")}</Text>
			</MenuItem>
			<MenuItem
				testID={`session:${session().id}:refresh`}
				indicatorClass="hidden"
				icon={<Icon name="RefreshCw" size={14} />}
				disabled={session().active}
				onSelect={() => void store.loadSessions(session().projectId)}
			>
				<Text class="font-sans">{() => t("chat.refreshSession")}</Text>
			</MenuItem>
			<MenuItem
				testID={`session:${session().id}:delete`}
				indicatorClass="hidden"
				icon={<Icon name="Trash2" size={14} />}
				variant="destructive"
				closeOnSelect={false}
				onSelect={confirmDelete}
			>
				<Text class="font-sans">
					{() =>
						confirmingDelete()
							? t("sidebar.confirmDelete")
							: t("sidebar.delete")
					}
				</Text>
			</MenuItem>
		</View>
	);

	const resetDelete = ({ open }: { open: boolean }) => {
		if (!open) confirmingDelete.set(false);
	};

	const rowClass = () => {
		const classes = [
			"group relative w-full min-w-0 flex-row items-center rounded-md border border-transparent",
			projectContext()
				? "min-h-(--pilo-sidebar-session-context-height) px-2 py-1"
				: "min-h-(--pilo-sidebar-session-height) px-2 py-0.5",
		];
		if (selected()) {
			classes.push(
				"border-(--pilo-sidebar-selected-border) bg-(--pilo-sidebar-selected-background)",
			);
		} else if (menuOpen()) {
			classes.push("bg-sidebar-hover");
		} else if (!glide) {
			classes.push("hover:bg-sidebar-hover");
		}
		return classes.join(" ");
	};
	const shownWhileMenu = (hidden: string, shown: string) =>
		menuOpen() ? shown : hidden;

	const title = () => (
		<View class="h-6 min-w-0 flex-row items-center">
			<Text
				class={`min-w-0 flex-1 truncate font-sans text-sm ${
					selected()
						? "text-sidebar-selection-foreground"
						: "text-sidebar-foreground dark:text-sidebar-foreground/75"
				}`}
			>
				{() => session().title}
			</Text>
		</View>
	);
	const projectTag = () => {
		const name = props.projectName?.();
		if (!name) return null;
		return (
			<View class="h-4 min-w-0 flex-row items-center gap-1">
				<Icon
					name="Folder"
					size={12}
					class="shrink-0 opacity-80"
					color={token("sidebar-foreground-muted")}
				/>
				<Text
					testID={`session:${session().id}:project`}
					class="min-w-0 flex-1 truncate font-sans text-[11px] leading-tight text-sidebar-foreground-muted"
				>
					{name}
				</Text>
			</View>
		);
	};
	const content = () => (
		<View
			class={`w-full min-w-0 flex-row gap-1.5 ${
				projectContext() ? "items-start" : "items-center"
			}`}
		>
			{leading()}
			<View class="min-w-0 flex-1">
				{() =>
					renaming() ? (
						<Input
							testID={`session:${session().id}:rename-input`}
							autoFocus
							value={renameValue()}
							accessibilityLabel={t("sidebar.editSessionTitle")}
							class="h-6 rounded-sm px-1 text-sm"
							onChange={(event) => renameValue.set(event.value)}
							onSubmit={submitRename}
							onBlur={submitRename}
							onKeyDown={(event) => {
								if (event.key === "Escape") renaming.set(false);
							}}
						/>
					) : (
						title()
					)
				}
				{projectTag}
			</View>
			{trailing()}
		</View>
	);

	const leading = () => (
		<View class="relative h-6 w-4 shrink-0 items-center justify-center">
			{() =>
				!session().active && session().unread ? (
					<View
						testID={`session:${session().id}:unread`}
						class={`size-1.5 -translate-y-px rounded-full bg-sidebar-primary transition-opacity duration-100 ${shownWhileMenu(
							"group-hover:opacity-0",
							"opacity-0",
						)}`}
					/>
				) : null
			}
			<Menu
				class="absolute top-0 -left-1 z-20 size-6"
				open={menuOpen()}
				onOpenChange={(event) => {
					menuOpen.set(event.open);
					resetDelete(event);
				}}
				align="start"
				popupStyle={{ minWidth: 0 }}
				trigger={
					<Button
						{...menuHover.props}
						testID={`session:${session().id}:menu`}
						class={`size-6 items-center justify-center rounded-md duration-100 hover:bg-sidebar-foreground/15 ${shownWhileMenu(
							HOVER_ACTION,
							"bg-sidebar-foreground/15 opacity-100",
						)}`}
						style={{ transitionProperty: "opacity, background-color" }}
						focusVisibleStyle={sidebarFocusRing()}
						accessibilityLabel={t("sidebar.moreActions")}
					>
						<Icon
							name="MoreHorizontal"
							size={14}
							color={token(
								menuHover.hovered() || menuOpen()
									? "sidebar-foreground"
									: "sidebar-foreground-muted",
							)}
						/>
					</Button>
				}
			>
				{menuItems}
			</Menu>
		</View>
	);
	const trailing = () => (
		<View class="relative size-6 shrink-0 items-center justify-center">
			{() =>
				session().active ? (
					<View
						testID={`session:${session().id}:running`}
						class={`size-1.5 -translate-y-px animate-pulse rounded-full bg-sidebar-primary transition-opacity duration-100 ${shownWhileMenu(
							"group-hover:opacity-0",
							"opacity-0",
						)}`}
					/>
				) : null
			}
			<ConfirmDeleteButton
				testID={`session:${session().id}:delete-button`}
				class={`absolute top-0 right-0 z-20 ${shownWhileMenu(
					HOVER_ACTION,
					"opacity-100",
				)}`}
				onConfirm={deleteSession}
			/>
		</View>
	);

	return (
		<View
			class="relative w-full min-w-0"
			onLayout={(event) => {
				bounds = event.bounds;
			}}
			onMouseEnter={() => glide?.show(bounds)}
		>
			<ContextMenu
				testID={`session:${session().id}:context`}
				open={contextOpen()}
				onOpenChange={(event) => {
					contextOpen.set(event.open);
					resetDelete(event);
				}}
				popupClass={menuPopupClass}
				popupStyle={{ ...menuPopupStyle(), minWidth: 0 }}
				trigger={
					renaming() ? (
						<View class={rowClass()}>{content()}</View>
					) : (
						<Button
							testID={`session:${session().id}`}
							class={rowClass()}
							focusVisibleStyle={sidebarFocusRing()}
							selected={selected()}
							accessibilityLabel={session().title}
							tooltip={
								<Tooltip
									placement="right"
									align="start"
									delay={600}
									class="max-w-[420px]"
								>
									<Text class="font-sans">{() => session().title}</Text>
								</Tooltip>
							}
							onPress={() =>
								store.selectSession(session().projectId, session().sessionPath)
							}
						>
							{content()}
						</Button>
					)
				}
			>
				{menuItems}
			</ContextMenu>
		</View>
	);
}
