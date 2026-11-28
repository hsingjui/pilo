import {
	type Accessor,
	type Bounds,
	cleanup,
	computed,
	effect,
	type InputRef,
	Overlay,
	reduceMotion,
	signal,
	Text,
	token,
	untracked,
	View,
	type ViewRef,
} from "nsh";
import { Button, ContextMenu } from "nsh/base";

import { userErrorMessage } from "@shared/app-error";
import type { SidebarSession } from "@shared/sidebar/sidebar-types";
import type { AppStore } from "../state/app-store";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { Menu, menuPopupClass, menuPopupStyle } from "../ui/menu";
import { MenuItem } from "../ui/menu-item";
import { createHover } from "../ui/hover";
import { MOTION, tactileTransition } from "../ui/motion";
import { AppToaster, showToast } from "./app-toasts";
import { setSessionArchivedWithToast } from "./archive-session";
import { deleteSessionWithToast } from "./delete-session";
import { t } from "./i18n";
import { sessionRowKey } from "./sidebar-projects";
import {
	HOVER_ACTION,
	sidebarFocusRing,
	sidebarRowHeight,
	sidebarText,
} from "./sidebar-parts";
import { sessionAgeText, SidebarSessionClock } from "./sidebar-session-age";
import { SessionGlideContext } from "./sidebar-session-glide";

/**
 * The delete button at a session row's end: a first press asks to confirm,
 * which resets after 3.5 s, when the pointer leaves or when the row shows
 * another session (`resetOn` changes).
 */
function ConfirmDeleteButton(props: {
	testID: string;
	class: string;
	resetOn: Accessor<string>;
	running?: Accessor<boolean>;
	onConfirm: () => void;
}) {
	const confirming = signal(false);
	let buttonRef: ViewRef | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const setConfirmingAnimated = (next: boolean) => {
		if (confirming() === next) return;
		if (!reduceMotion()) {
			buttonRef?.animateLayout({
				type: "spring",
				...MOTION.spring.crisp,
			});
		}
		confirming.set(next);
	};
	const reset = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		setConfirmingAnimated(false);
	};
	effect(() => {
		props.resetOn();
		untracked(() => {
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
			confirming.set(false);
		});
	});
	cleanup(() => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	});
	const hover = createHover();
	const confirmLabel = () =>
		props.running?.()
			? t("sidebar.deleteRunningConfirm")
			: t("sidebar.confirmDelete");
	return (
		<Button
			ref={(node) => {
				buttonRef = node;
			}}
			testID={props.testID}
			class={`${props.class} ${
				confirming()
					? "z-10 h-6 min-w-10 flex-row items-center justify-center overflow-hidden rounded-full border border-destructive/20 bg-sidebar-background px-2"
					: "size-6 items-center justify-center rounded-sm"
			}`}
			style={[
				tactileTransition("opacity, background-color, border-color"),
				confirming() ? { width: "max-content" } : undefined,
			]}
			focusVisibleStyle={sidebarFocusRing()}
			accessibilityLabel={confirming() ? confirmLabel() : t("sidebar.delete")}
			onMouseEnter={hover.props.onMouseEnter}
			onMouseLeave={() => {
				hover.props.onMouseLeave();
				if (confirming()) reset();
			}}
			onPress={() => {
				if (!confirming()) {
					if (timer !== undefined) clearTimeout(timer);
					setConfirmingAnimated(true);
					timer = setTimeout(() => {
						timer = undefined;
						setConfirmingAnimated(false);
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
						<Text
							class="shrink-0 whitespace-nowrap font-sans font-medium leading-none text-destructive"
							style={sidebarText("2xs")}
						>
							{confirmLabel}
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
	onSelectChat?: (projectId: string) => void;
	/** The session's project, for a list that mixes projects. */
	projectName?: Accessor<string | undefined>;
}) {
	const { store } = props;
	const session = props.session;
	const now = SidebarSessionClock();
	const age = computed(() => sessionAgeText(session().latestMessageAt, now()));
	const toasts = AppToaster();
	const glide = SessionGlideContext();
	const trackViewportRow = glide?.trackViewportRow;
	let bounds: Bounds | null = null;
	const menuOpen = signal(false);
	const contextOpen = signal(false);
	const archiveFocused = signal(false);
	const confirmingDelete = signal(false);
	const renaming = signal(false);
	const renameValue = signal("");
	const renameInput = signal<InputRef | null>(null);
	let renamePending = false;
	const menuHover = createHover();
	// A new chat Pi has not saved yet has no file to rename, refresh or delete.
	// A list cell is reused for other sessions, so this follows the session.
	const saved = computed(() => session().sessionPath !== "");
	const archived = computed(() => session().archivedAt != null);
	const archiveLabel = () =>
		session().active ? t("sidebar.archiveRunning") : t("sidebar.archive");
	const toggleArchive = () => {
		const current = session();
		if (current.active && !archived()) return;
		void setSessionArchivedWithToast(
			store,
			toasts,
			current.projectId,
			current.sessionPath,
			!archived(),
		);
	};
	// What the row was doing for one session never shows on another: a
	// recycled cell starts over (a row with its menu open or its title being
	// edited holds the focus or an overlay, so the list keeps it bound).
	const rowKey = computed(() => sessionRowKey(session()));
	effect(() => {
		rowKey();
		untracked(() => {
			renamePending = false;
			menuOpen.set(false);
			contextOpen.set(false);
			archiveFocused.set(false);
			confirmingDelete.set(false);
			renaming.set(false);
		});
	});
	const selected = computed(() => {
		const open = store.openSession();
		const current = session();
		if (open?.projectId !== current.projectId) return false;
		return saved()
			? open.sessionPath === current.sessionPath
			: !open.sessionPath && open.sessionId === current.id;
	});
	const projectContext = () => Boolean(props.projectName?.());

	const startRenameAfterMenuClose = () => {
		if (!renamePending) return;
		renamePending = false;
		// Let the menu finish restoring focus before the input takes it.
		renameValue.set(session().title);
		renaming.set(true);
	};
	const submitRename = () => {
		if (!renaming()) return;
		const title = renameValue().trim();
		renaming.set(false);
		if (title && title !== session().title) {
			void store
				.renameSession(session().projectId, session().sessionPath, title)
				.catch((error: unknown) => {
					showToast(toasts, {
						variant: "error",
						title: t("chat.renameSessionFailed"),
						description: userErrorMessage(error),
					});
				});
		}
	};

	const deleteSession = () =>
		void deleteSessionWithToast(
			store,
			toasts,
			session().projectId,
			session().sessionPath,
		);

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
					renamePending = true;
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
				testID={`session:${session().id}:archive`}
				indicatorClass="hidden"
				icon={<Icon name="Archive" size={14} />}
				disabled={session().active}
				onSelect={toggleArchive}
			>
				<Text class="font-sans">{archiveLabel}</Text>
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
							? session().active
								? t("sidebar.deleteRunningConfirm")
								: t("sidebar.confirmDelete")
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
			projectContext() ? "px-2 py-1" : "px-2 py-0.5",
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
	const rowStyle = () => ({
		minHeight: sidebarRowHeight(
			projectContext()
				? "pilo-sidebar-session-context-height"
				: "pilo-sidebar-session-height",
		),
	});
	const shownWhileMenu = (hidden: string, shown: string) =>
		menuOpen() ? shown : hidden;

	const title = () => (
		<View class="min-h-6 min-w-0 flex-row items-center">
			<Text
				testID={`session:${session().id}:title`}
				class={`min-w-0 flex-1 truncate font-sans ${
					selected()
						? "text-sidebar-selection-foreground"
						: "text-sidebar-foreground dark:text-sidebar-foreground/75"
				}`}
				style={sidebarText("sm")}
			>
				{() => session().title}
			</Text>
		</View>
	);
	const projectTag = () => {
		const name = props.projectName?.();
		if (!name) return null;
		return (
			<View class="min-h-4 min-w-0 flex-row items-center gap-1">
				<Icon
					name="Folder"
					size={12}
					class="shrink-0 opacity-80"
					color={token("sidebar-foreground-muted")}
				/>
				<Text
					testID={`session:${session().id}:project`}
					class="min-w-0 flex-1 truncate font-sans leading-tight text-sidebar-foreground-muted"
					style={sidebarText("2xs")}
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
			{() => (archived() ? null : leading())}
			<View class="min-w-0 flex-1">
				{() =>
					renaming() ? (
						<>
							<Input
								ref={renameInput.set}
								testID={`session:${session().id}:rename-input`}
								autoFocus
								value={renameValue()}
								accessibilityLabel={t("sidebar.editSessionTitle")}
								class="min-h-6 h-auto rounded-sm px-1 py-0"
								style={{ fontSize: sidebarText("sm").fontSize }}
								onChange={(event) => renameValue.set(event.value)}
								onSubmit={submitRename}
								onBlur={submitRename}
								onKeyDown={(event) => {
									if (event.key === "Escape") renaming.set(false);
								}}
							/>
							{/* Native inputs can keep focus when clicking a non-focusable view. */}
							<Overlay
								anchor={renameInput()}
								style={{ width: 0, height: 0, pointerEvents: "box-none" }}
								onPressOutside={submitRename}
							/>
						</>
					) : (
						title()
					)
				}
				{projectTag}
			</View>
			{trailing()}
		</View>
	);

	const unreadMarker = () =>
		!session().active &&
		session().unread &&
		!store.isViewingSession(session().projectId, session().sessionPath) ? (
			<View
				testID={`session:${session().id}:unread`}
				class={`size-1.5 -translate-y-px rounded-full bg-sidebar-primary transition-opacity duration-100 ${shownWhileMenu(
					"group-hover:opacity-0",
					"opacity-0",
				)}`}
			/>
		) : null;

	const leading = () => (
		<View class="relative h-6 w-4 shrink-0 items-center justify-center">
			{unreadMarker}
			{() =>
				saved() ? (
					<Menu
						class="absolute top-0 -left-1 z-20 size-6"
						open={menuOpen()}
						onOpenChange={(event) => {
							menuOpen.set(event.open);
							resetDelete(event);
						}}
						onClose={startRenameAfterMenuClose}
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
				) : null
			}
		</View>
	);
	const ageInArchiveSlotClass = () => {
		if (!saved()) return "";
		if (archiveFocused() || menuOpen()) return "opacity-0";
		return "group-hover:opacity-0";
	};
	const ageLabel = (className?: Accessor<string>) => (
		<Text
			class={`pointer-events-none shrink-0 whitespace-nowrap font-sans tabular-nums text-sidebar-foreground-muted ${className?.() ?? ""}`}
			style={sidebarText("xs")}
		>
			{age}
		</Text>
	);

	const trailing = () =>
		archived() && saved() ? (
			<View class="shrink-0 flex-row items-center gap-1">
				{unreadMarker}
				{() => (age() ? ageLabel() : null)}
				<Button
					testID={`session:${session().id}:unarchive-button`}
					class={`size-6 items-center justify-center rounded-sm hover:bg-sidebar-foreground/15 ${HOVER_ACTION}`}
					focusVisibleStyle={sidebarFocusRing()}
					accessibilityLabel={t("sidebar.unarchive")}
					onPress={toggleArchive}
				>
					<Icon
						name="ArchiveRestore"
						size={14}
						color={token("sidebar-foreground-muted")}
					/>
				</Button>
				<ConfirmDeleteButton
					testID={`session:${session().id}:delete-button`}
					class={HOVER_ACTION}
					resetOn={rowKey}
					running={() => Boolean(session().active)}
					onConfirm={deleteSession}
				/>
			</View>
		) : (
			<View
				class={`relative h-6 min-w-6 shrink-0 flex-row items-center gap-1 ${age() ? "justify-end" : "justify-center"}`}
				onFocusIn={() => archiveFocused.set(true)}
				onFocusOut={() => archiveFocused.set(false)}
			>
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
				{() => (age() ? ageLabel(ageInArchiveSlotClass) : null)}
				{() =>
					saved() ? (
						<Button
							testID={`session:${session().id}:archive-button`}
							class={`absolute top-0 right-0 z-20 size-6 items-center justify-center rounded-sm hover:bg-sidebar-foreground/15 ${shownWhileMenu(
								HOVER_ACTION,
								"opacity-100",
							)}`}
							focusVisibleStyle={sidebarFocusRing()}
							accessibilityLabel={archiveLabel()}
							disabled={session().active}
							onPress={toggleArchive}
						>
							<Icon
								name="Archive"
								size={14}
								color={token("sidebar-foreground-muted")}
							/>
						</Button>
					) : null
				}
			</View>
		);

	const rowTrigger = () =>
		renaming() ? (
			<View class={rowClass()} style={rowStyle()}>
				{content()}
			</View>
		) : (
			<Button
				testID={`session:${session().id}`}
				class={rowClass()}
				style={rowStyle()}
				focusVisibleStyle={sidebarFocusRing()}
				selected={selected()}
				accessibilityLabel={
					age() ? `${session().title}, ${age()}` : session().title
				}
				onPress={() => {
					glide?.dismiss();
					const { projectId, sessionPath, id } = session();
					props.onSelectChat?.(projectId);
					if (sessionPath) store.selectSession(projectId, sessionPath);
					else store.selectDraft(projectId, id);
				}}
			>
				{content()}
			</Button>
		);

	return (
		<View
			class="relative w-full min-w-0"
			onLayout={(event) => {
				bounds = event.bounds;
			}}
			onMouseEnter={trackViewportRow ? undefined : () => glide?.show(bounds)}
			onMouseLeave={glide?.leaveViewportRow}
			onMouseMove={
				trackViewportRow
					? (event) => trackViewportRow(bounds, event)
					: undefined
			}
		>
			{() =>
				archived() ? (
					rowTrigger()
				) : (
					<ContextMenu
						testID={`session:${session().id}:context`}
						disabled={!saved()}
						open={contextOpen()}
						onOpenChange={(event) => {
							contextOpen.set(event.open);
							resetDelete(event);
						}}
						onClose={startRenameAfterMenuClose}
						popupClass={menuPopupClass}
						popupStyle={{ ...menuPopupStyle(), minWidth: 0 }}
						trigger={rowTrigger()}
					>
						{menuItems}
					</ContextMenu>
				)
			}
		</View>
	);
}
