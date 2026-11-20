import {
	type InputRef,
	Overlay,
	platform,
	Scroll,
	type ScrollRef,
	Text,
	View,
	type ViewRef,
	cleanup,
	computed,
	effect,
	keymap,
	signal,
	token,
	windowSize,
} from "nsh";
import { Picker } from "nsh";
import { Button as BaseButton, Input as BaseInput } from "nsh/base";

import {
	DEFAULT_SUGGESTIONS,
	FILE_SUGGESTION_LIMIT,
	TRIGGER_META,
	activeSuggestionQuery,
	type ComposerSuggestion,
	type MentionTab,
} from "@/lib/chat/composer-suggestions";
import { formatChatImageSize } from "@/lib/chat/chat-submission";
import { sessionMentionValue } from "@/lib/chat/session-mentions";
import { DEFAULT_READING_FONT_SIZE } from "@/lib/font-settings";
import type { SendMessageShortcut } from "@/lib/host-preferences-types";

import { t } from "../app/i18n";
import { DEFAULT_CHAT_REM } from "../chat/layout";
import { APP_SHORTCUTS } from "../shortcuts";
import { Button } from "../ui/button";
import { focusRingStyle } from "../ui/focus-ring-style";
import { createHover } from "../ui/hover";
import { Icon, type IconName } from "../ui/icon";
import { menuPopupClass, menuPopupStyle } from "../ui/menu";
import { menuRowClass } from "../ui/menu-row";
import { styleVar } from "../ui/theme-style";
import { Tooltip } from "../ui/tooltip";
import { ComposerActions } from "./composer-actions";
import { ComposerContextUsage } from "./composer-context-usage";
import {
	ComposerRunConfig,
	type ComposerRunConfigProps,
} from "./composer-run-config";
import type { ComposerStore } from "./composer-store";

/** The React composer grows to 12 lines, then scrolls. */
const MAX_ROWS = 12;
/** The input keeps its native leading with a small inset above and below. */
const INPUT_PADDING = 4;
const CHAT_SCALE = DEFAULT_CHAT_REM / 16;

const composerShadow = () => {
	const shadow = styleVar("pilo-shadow-composer");
	// The default Lody composer is flat on the web. Give the native card elevation.
	return shadow && shadow !== "0 0 #0000" ? shadow : styleVar("pilo-shadow-sm");
};

/** The focused surface's shadow; only some theme families define one. */
const focusShadow = () =>
	(styleVar as (name: string) => string | undefined)(
		"pilo-shadow-composer-focus",
	) ?? composerShadow();

const COMPOSER_SURFACE =
	"relative w-full rounded-(--pilo-composer-radius) border border-(--pilo-composer-border) bg-(--pilo-composer-background)";
const COMPOSER_TOOLBAR =
	"-ml-1 min-w-0 flex-row items-center gap-(--pilo-composer-toolbar-gap)";

function surfaceStyle(focused: boolean) {
	return {
		borderColor: focused ? token("pilo-composer-focus-border") : undefined,
		boxShadow: focused ? focusShadow() : composerShadow(),
		gap: token("pilo-composer-gap") * CHAT_SCALE,
		paddingHorizontal: DEFAULT_CHAT_REM * 0.5,
		paddingVertical: DEFAULT_CHAT_REM * 0.375,
	};
}

function toolbarStyle() {
	return {
		minHeight:
			token("pilo-composer-control-size") * CHAT_SCALE + DEFAULT_CHAT_REM / 8,
		paddingTop: DEFAULT_CHAT_REM / 8,
	};
}

function inputHeight(contentHeight: number, fontSize: number) {
	// Keep the theme minimum or two rows, whichever is taller, as in Tauri.
	const lineHeight = Math.max(20, fontSize * 1.25);
	const min = Math.max(
		token("pilo-composer-input-height") * CHAT_SCALE,
		lineHeight * 2 + INPUT_PADDING,
	);
	return Math.max(
		min,
		Math.min(
			Math.ceil(contentHeight) + INPUT_PADDING,
			lineHeight * MAX_ROWS + INPUT_PADDING,
		),
	);
}

export interface ChatComposerProps {
	/** The open chat's composer state and actions. */
	store: ComposerStore;
	/** The configured submit shortcut; Enter submits by default. */
	sendShortcut?: () => SendMessageShortcut | undefined;
	/** The reading font size the messages use, in points. */
	readingFontSize?: () => number | undefined;
	/** The model · thinking control; the toolbar leaves it out without one. */
	runConfig?: ComposerRunConfigProps;
}

/**
 * The prompt bar under a chat: a growing multiline input with `@` file and
 * session mentions, `/` commands, picked, pasted and dropped attachments,
 * per-session drafts and per-project input history, and send or stop.
 */
export function ChatComposer(props: ChatComposerProps) {
	const store = props.store;
	const surfaceWidth = signal(0);
	const index = signal(0);
	const dismissedQuery = signal<string | null>(null);
	const contentHeight = signal(0);
	const focused = signal(false);
	const surface = signal<ViewRef | undefined>(undefined);
	let input: InputRef | undefined;

	const state = () => store.state();
	const running = () => store.running();
	const modEnter = () => (props.sendShortcut?.() ?? "enter") === "mod-enter";
	const hasContent = () =>
		state().value.trim().length > 0 || state().images.length > 0;

	const query = computed(
		() => activeSuggestionQuery(state().value, state().caret),
		{
			equals: (previous, next) =>
				previous?.trigger === next?.trigger &&
				previous?.start === next?.start &&
				previous?.end === next?.end &&
				previous?.query === next?.query,
		},
	);
	const queryKey = () => {
		const active = query();
		return active
			? `${store.target()?.sessionKey ?? ""}:${active.start}:${active.trigger}:${active.query}`
			: null;
	};
	const dismissSuggestions = () => dismissedQuery.set(queryKey());

	// The `@` menu's tab, and whether the keys move along the tabs or the
	// rows, for the `@` they were set at: React's `mentionNavigation`.
	const mentionNavigation = signal<{
		start: number;
		tab: MentionTab;
		categoryFocused: boolean;
	} | null>(null);
	const mentionAtQuery = () => {
		const active = query();
		const navigation = mentionNavigation();
		return active?.trigger === "@" && navigation?.start === active.start
			? navigation
			: null;
	};
	// Moving focus between the tabs and rows doesn't change the candidate list.
	const mentionTab = computed<MentionTab>(
		() => mentionAtQuery()?.tab ?? "file",
	);
	// A bare `@` starts on the tabs, a typed query on its first row.
	const categoryFocused = () => {
		const active = query();
		if (active?.trigger !== "@") return false;
		return mentionAtQuery()?.categoryFocused ?? !active.query;
	};

	// As React: one kind per menu, matched on label, value and detail.
	const items = (): readonly ComposerSuggestion[] => {
		const active = query();
		if (!active) return [];
		const needle = active.query.toLowerCase();
		const matches = (suggestion: ComposerSuggestion) =>
			!needle ||
			[suggestion.label, suggestion.value, suggestion.detail].some((part) =>
				part?.toLowerCase().includes(needle),
			);
		if (active.trigger === "/") {
			return [...DEFAULT_SUGGESTIONS, ...(store.commands() ?? [])]
				.filter(matches)
				.slice(0, 9);
		}
		const candidates =
			mentionTab() === "session"
				? store.sessionMentions().map((mention): ComposerSuggestion => ({
						kind: "session",
						value: sessionMentionValue(mention.path),
						label: mention.title,
						detail: mention.projectName,
					}))
				: store.fileSuggestions();
		return candidates.filter(matches).slice(0, FILE_SUGGESTION_LIMIT);
	};

	const changeMentionTab = (tab: MentionTab) => {
		const active = query();
		if (active?.trigger !== "@") return;
		mentionNavigation.set({ start: active.start, tab, categoryFocused: true });
		index.set(0);
		input?.focus();
	};
	const enterCandidates = () => {
		const active = query();
		if (active?.trigger === "@" && categoryFocused()) {
			mentionNavigation.set({
				start: active.start,
				tab: mentionTab(),
				categoryFocused: false,
			});
		}
	};

	// Open while a query is typed, with an empty state, as in React.
	const menuOpen = () => {
		const key = queryKey();
		return focused() && key !== null && key !== dismissedQuery();
	};

	// While the menu shows, its keys are bound over the input's own
	// (`when: "always"`): a native input keeps its arrows from `onKeyPress`.
	// A new list highlights its first row.
	effect(() => {
		items();
		index.set(0);
	});
	effect(() => {
		if (!focused()) return;
		const active = query();
		if (!active) {
			dismissedQuery.set(null);
			mentionNavigation.set(null);
			return;
		}
		if (!menuOpen()) return;
		const count = items().length;
		const onTabs = categoryFocused();
		const bindings: Record<string, () => void> = {
			escape: dismissSuggestions,
		};
		// Tab switches the `@` tabs while they have the keys, else picks.
		if (onTabs) {
			bindings.tab = () =>
				changeMentionTab(mentionTab() === "file" ? "session" : "file");
		}
		// Up from the first row goes back to the tabs.
		if (active.trigger === "@" && !onTabs) {
			bindings.up = () => {
				if (index() === 0) changeMentionTab(mentionTab());
				else index.update((i) => i - 1);
			};
		}
		if (count) {
			if (!onTabs) bindings.tab = () => pick(items()[index()]);
			bindings.enter = () => pick(items()[onTabs ? 0 : index()]);
			bindings.down = () => {
				enterCandidates();
				index.update((i) => (onTabs ? 0 : (i + 1) % count));
			};
			bindings.up ??= () => {
				enterCandidates();
				index.update((i) => (onTabs ? count - 1 : (i - 1 + count) % count));
			};
		}
		cleanup(keymap.bind(bindings, { when: "always", repeat: true }));
	});

	// "mod+enter" submits when the preference says so; Return stays a newline.
	effect(() => {
		if (!focused() || !modEnter()) return;
		cleanup(
			keymap.bind(APP_SHORTCUTS.sendMessage, () => submit(), {
				when: "always",
			}),
		);
	});

	// File suggestions follow the `@` query, debounced.
	effect(() => {
		const active = query();
		if (active?.trigger !== "@" || !store.target()) {
			store.clearFileSuggestions();
			return;
		}
		const timer = setTimeout(() => {
			void store.searchFileSuggestions(active.query);
		}, 150);
		cleanup(() => clearTimeout(timer));
	});

	// `/` asks the chat for its commands once.
	effect(() => {
		if (query()?.trigger === "/" && store.target()) void store.loadCommands();
	});

	const pick = (suggestion: ComposerSuggestion | undefined) => {
		const active = query();
		if (!suggestion || !active || !input) return;
		const inserted = `${suggestion.value} `;
		const value = state().value;
		const next =
			value.slice(0, active.start) + inserted + value.slice(state().caret);
		store.setValue(next, active.start + inserted.length);
		// `insertText` is not carried out on macOS in nsh 0.6.0, so the pick
		// writes the controlled value and restores the caret itself.
		input.setSelection(active.start + inserted.length);
		input.focus();
	};

	const submit = () => {
		if (menuOpen() && items().length > 0) return;
		void store.submit();
	};

	const pickFiles = () => {
		const target = store.target();
		if (!target) return;
		void Picker.pickFiles({ multiple: true })
			.then((picked) =>
				store.addFiles(
					picked.flatMap((entry) => (entry.file ? [entry.file] : [])),
					target,
				),
			)
			.catch((error: unknown) =>
				store.setStatus(
					error instanceof Error ? error.message : String(error),
					target.sessionKey,
				),
			);
	};

	const arrowKeys = (direction: "older" | "newer") => {
		void store.navigateHistory(direction);
	};

	effect(() => {
		if (!focused() || menuOpen()) return;
		cleanup(
			keymap.bind(
				{
					up: () => arrowKeys("older"),
					down: () => arrowKeys("newer"),
				},
				{ when: "always" },
			),
		);
	});

	const attachments = () => {
		const draft = store.mentionDraft();
		return {
			images: state().images,
			references: draft.references,
		};
	};

	const fontSize = () => props.readingFontSize?.() ?? DEFAULT_READING_FONT_SIZE;
	const disabled = () => store.target() === null;
	const blocked = () =>
		disabled() || state().sending || (running() && store.compacting());
	const config = () => props.runConfig?.config() ?? null;

	return (
		<View
			testID="chat-composer"
			class="relative w-full"
			onFileDragEnter={() => store.setDragging(true)}
			onFileDragLeave={() => store.setDragging(false)}
			onFileDrop={({ uris }) => {
				store.setDragging(false);
				void store.addUris(uris);
			}}
		>
			{() =>
				state().status ? (
					<View
						testID="chat-composer-status"
						role="alert"
						class="mb-2 min-w-0 rounded-xl border border-border/60 bg-muted px-3 py-2"
					>
						<View selectable>
							<Text class="font-sans text-xs leading-5 text-destructive">
								{() => state().status ?? ""}
							</Text>
						</View>
					</View>
				) : null
			}
			<View
				ref={(ref) => surface.set(ref)}
				testID="chat-composer-surface"
				onLayout={({ bounds }) => surfaceWidth.set(bounds.size.width)}
				class={COMPOSER_SURFACE}
				style={surfaceStyle(focused())}
			>
				{() =>
					attachments().images.length > 0 ||
					attachments().references.length > 0 ? (
						<View class="mb-1 min-w-0 flex-row flex-wrap items-center gap-1.5 p-1">
							{attachments().images.map((image) => (
								<AttachmentChip
									label={`${image.name} (${formatChatImageSize(image.size)})`}
									removeLabel={t("chat.removeAttachment", { name: image.name })}
									icon="File"
									onRemove={() => store.removeImage(image.id)}
								/>
							))}
							{attachments().references.map((reference, i) => {
								const name = reference.path.split("/").pop() ?? reference.path;
								return (
									<AttachmentChip
										label={name}
										removeLabel={t("chat.removeAttachment", { name })}
										icon={
											reference.kind === "session" ? "MessageSquare" : "File"
										}
										onRemove={() => store.removeReference(i)}
									/>
								);
							})}
						</View>
					) : null
				}
				<BaseInput
					ref={(ref) => {
						input = ref;
					}}
					testID="chat-composer-input"
					multiline
					autoCorrect={false}
					autoCapitalize="none"
					disabled={disabled()}
					readonly={disabled()}
					submitBehavior={modEnter() ? "newline" : "submit"}
					pasteBehavior="insert"
					value={state().value}
					accessibilityLabel={t("chat.composerPlaceholder")}
					placeholder={
						attachments().images.length === 0 &&
						attachments().references.length === 0
							? t("chat.composerPlaceholder")
							: undefined
					}
					// The size goes in the class: an inline `fontSize` reaches the typed
					// text but not the placeholder, which then sits larger and lower.
					class={`w-full min-w-0 border-0 bg-transparent px-1 font-sans text-[${fontSize()}px] text-input-foreground placeholder:text-input-placeholder`}
					style={{
						height: inputHeight(contentHeight(), fontSize()),
						minHeight: 0,
						paddingTop: INPUT_PADDING / 2,
						paddingBottom: INPUT_PADDING / 2,
					}}
					onContentSizeChange={({ size }) => contentHeight.set(size.height)}
					onFocus={() => focused.set(true)}
					onBlur={() => focused.set(false)}
					onChange={({ value }) => store.setValue(value)}
					onSelectionChange={({ end }) => store.setCaret(end)}
					onCompositionChange={({ composing }) => store.setComposing(composing)}
					onSubmit={() => submit()}
					onPaste={({ files, uris }) => {
						if (files.length) void store.addFiles(files);
						if (uris.length) void store.addUris(uris);
					}}
				/>
				<View
					testID="chat-composer-toolbar"
					class={COMPOSER_TOOLBAR}
					style={toolbarStyle()}
				>
					<Button
						testID="chat-composer-attach"
						variant="ghost"
						size="icon"
						class="h-(--pilo-composer-control-size) w-(--pilo-composer-attachment-width) rounded-(--pilo-radius-md)"
						disabled={blocked()}
						accessibilityLabel={t("chat.addAttachment")}
						tooltip={
							<Tooltip>
								<Text class="font-sans">{() => t("chat.addAttachment")}</Text>
							</Tooltip>
						}
						onPress={pickFiles}
					>
						<Icon name="Plus" size={16} color={token("muted-foreground")} />
					</Button>
					{props.runConfig ? <ComposerRunConfig {...props.runConfig} /> : null}
					{props.runConfig ? (
						<ComposerContextUsage
							usage={() => config()?.session ?? null}
							contextWindow={() => config()?.model?.contextWindow}
						/>
					) : null}
					<ComposerActions
						sendMode={() => state().sendMode}
						onSendModeChange={(mode) => store.setSendMode(mode)}
						running={running}
						hasContent={hasContent}
						blocked={blocked}
						sending={() => state().sending}
						sendShortcut={() => (modEnter() ? "mod-enter" : "enter")}
						onSend={submit}
						onStop={() => void store.stop()}
					/>
				</View>
				{() =>
					state().dragging ? (
						<View
							testID="chat-composer-drop"
							class="absolute inset-0 z-20 items-center justify-center rounded-(--pilo-composer-radius) bg-background/90 px-3"
						>
							<Text class="font-sans text-sm text-foreground">
								{() => t("chat.dropFiles")}
							</Text>
						</View>
					) : null
				}
			</View>
			{() => {
				if (!focused()) return null;
				// A click on a non-focusable view doesn't blur native inputs on Windows.
				return (
					<Overlay
						anchor={surface()}
						style={{ width: 0, height: 0, pointerEvents: "box-none" }}
						onPressOutside={() => input?.blur()}
					>
						{() =>
							menuOpen() ? (
								<Overlay
									anchor={surface()}
									placement="top"
									align="start"
									offset={6}
									onCancel={dismissSuggestions}
								>
									<SuggestionMenu
										trigger={() => query()?.trigger ?? "@"}
										query={() => query()?.query ?? ""}
										width={surfaceWidth}
										tab={mentionTab}
										categoryFocused={categoryFocused}
										onTab={changeMentionTab}
										items={items}
										index={() => (categoryFocused() ? -1 : index())}
										onHighlight={(i) => index.set(i)}
										onPick={pick}
									/>
								</Overlay>
							) : null
						}
					</Overlay>
				);
			}}
		</View>
	);
}

const SUGGESTION_ICONS: Record<ComposerSuggestion["kind"], IconName> = {
	file: "FileCode2",
	session: "MessageSquare",
	command: "TerminalSquare",
};

/**
 * The `@`/`/` menu over the composer, as React's `ComposerSuggestionMenu`:
 * the menu surface and rows, an icon, the name and its detail on one line;
 * `@` adds its file and session tabs over a list that scrolls.
 */
function SuggestionMenu(props: {
	trigger: () => "@" | "/";
	query: () => string;
	width: () => number;
	tab: () => MentionTab;
	categoryFocused: () => boolean;
	onTab: (tab: MentionTab) => void;
	items: () => readonly ComposerSuggestion[];
	/** The highlighted row; -1 while the `@` tabs have the keys. */
	index: () => number;
	onHighlight: (index: number) => void;
	onPick: (suggestion: ComposerSuggestion) => void;
}) {
	const title = () =>
		props.trigger() === "@" && props.tab() === "session"
			? t("chat.sessionSuggestion")
			: t(TRIGGER_META[props.trigger()].titleKey);
	let list: ScrollRef | undefined;
	const rows: (ViewRef | undefined)[] = [];
	// The highlighted row stays in view, as React scrolls its list.
	effect(() => {
		const i = props.index();
		props.items();
		if (i < 0) list?.scrollTo({ y: 0, animated: false });
		else rows[i]?.reveal({ vertical: "nearest", animated: false });
	});
	return (
		<View
			testID="chat-composer-suggestions"
			class={`${menuPopupClass} min-w-0 overflow-hidden`}
			style={[
				menuPopupStyle(),
				{
					width: Math.min(props.width(), props.trigger() === "/" ? 520 : 600),
				},
			]}
		>
			{() =>
				props.trigger() === "@" ? (
					<MentionTabs
						tab={props.tab}
						categoryFocused={props.categoryFocused}
						onTab={props.onTab}
					/>
				) : null
			}
			<Scroll
				ref={(ref) => {
					list = ref;
				}}
				role="listbox"
				accessibilityLabel={title()}
				contentClass="gap-(--pilo-menu-item-gap)"
				// React's `min(18rem | 13rem, 40% of the viewport)`.
				style={{
					maxHeight: Math.min(
						props.trigger() === "/" ? 288 : 208,
						windowSize().height * 0.4,
					),
				}}
			>
				{() => {
					const entries = props.items();
					rows.length = 0;
					if (!entries.length) {
						return (
							<Text class="px-3 py-4 text-center font-sans text-xs text-muted-foreground">
								{() =>
									props.query()
										? t("chat.noSuggestionMatch", {
												query: props.query(),
												title: title(),
											})
										: t("chat.noSuggestionAvailable", { title: title() })
								}
							</Text>
						);
					}
					return entries.map((suggestion, i) => {
						const highlighted = () => i === props.index();
						return (
							<View
								ref={(ref) => {
									rows[i] = ref;
								}}
								testID={`chat-composer-suggestion:${i}`}
								role="option"
								accessibilityState={{ selected: highlighted() }}
								// Picked with the pointer, the focus stays in the input.
								focusable={false}
								class={`${menuRowClass} ${highlighted() ? "bg-hover" : ""}`}
								onMouseEnter={() => props.onHighlight(i)}
								onPress={() => props.onPick(suggestion)}
							>
								<View class="size-3.5 shrink-0 items-center justify-center">
									<Icon
										name={
											suggestion.skill
												? "Sparkles"
												: SUGGESTION_ICONS[suggestion.kind]
										}
										size={12}
										color={token("muted-foreground")}
									/>
								</View>
								<Text
									class={`min-w-0 flex-1 truncate text-xs ${
										suggestion.kind === "session" ? "font-sans" : "font-mono"
									} ${highlighted() ? "text-hover-foreground" : "text-foreground"}`}
								>
									{suggestion.label}
								</Text>
								{suggestion.detail ? (
									<Text class="min-w-0 max-w-[45%] shrink truncate font-sans text-xs text-muted-foreground">
										{suggestion.detail}
									</Text>
								) : null}
							</View>
						);
					});
				}}
			</Scroll>
		</View>
	);
}

/** The `@` menu's file and session tabs, with the Tab hint while they have the keys. */
function MentionTabs(props: {
	tab: () => MentionTab;
	categoryFocused: () => boolean;
	onTab: (tab: MentionTab) => void;
}) {
	return (
		<View
			role="tablist"
			accessibilityLabel={t("chat.mentionCategories")}
			class="mb-1 flex-row items-center gap-1 px-1 pt-1"
		>
			{(["file", "session"] as const).map((tab) => {
				const hover = createHover();
				const active = () => props.tab() === tab;
				return (
					<View
						{...hover.props}
						testID={`chat-composer-mention-tab:${tab}`}
						role="tab"
						accessibilityState={{ selected: active() }}
						focusable={false}
						class={`h-7 shrink-0 flex-row items-center justify-center gap-1.5 rounded-md px-2.5 hover:bg-hover ${
							active() && props.categoryFocused() ? "bg-muted" : ""
						}`}
						onPress={() => props.onTab(tab)}
					>
						<Icon
							name={SUGGESTION_ICONS[tab]}
							size={14}
							color={token(
								active() || hover.hovered() ? "foreground" : "muted-foreground",
							)}
						/>
						<Text
							class={`font-sans text-xs font-medium ${
								active() || hover.hovered()
									? "text-foreground"
									: "text-muted-foreground"
							}`}
						>
							{() =>
								t(
									tab === "file"
										? "chat.fileSuggestion"
										: "chat.sessionSuggestion",
								)
							}
						</Text>
					</View>
				);
			})}
			{() =>
				props.categoryFocused() && platform.desktop ? (
					<View class="ml-auto min-w-0 shrink flex-row items-center gap-1.5 pl-2 pr-1">
						<View class="shrink-0 rounded-sm border border-border/70 bg-muted/50 px-1">
							<Text class="font-mono text-[11px] text-muted-foreground">
								Tab
							</Text>
						</View>
						<Text class="min-w-0 shrink truncate font-sans text-[11px] text-muted-foreground">
							{() => t("chat.mentionTabSwitchHint")}
						</Text>
					</View>
				) : null
			}
		</View>
	);
}

function AttachmentChip(props: {
	label: string;
	removeLabel: string;
	icon: "File" | "MessageSquare";
	onRemove: () => void;
}) {
	// React's `ComposerAttachment`: a borderless muted chip, 12rem at most,
	// whose remove button fills its height.
	const hover = createHover();
	return (
		<View class="h-7 min-w-0 max-w-48 flex-row items-center rounded-md bg-muted/60">
			<View class="h-full min-w-0 flex-1 flex-row items-center gap-1.5 px-2">
				<Icon name={props.icon} size={12} color={token("muted-foreground")} />
				<Text class="min-w-0 shrink truncate font-sans text-xs text-foreground">
					{() => props.label}
				</Text>
			</View>
			<BaseButton
				class="h-full w-6 shrink-0 items-center justify-center rounded-r-md transition-colors hover:bg-hover"
				focusVisibleStyle={focusRingStyle(token("ring"))}
				accessibilityLabel={props.removeLabel}
				{...hover.props}
				onPress={props.onRemove}
			>
				<Icon
					name="X"
					size={12}
					color={token(hover.hovered() ? "foreground" : "muted-foreground")}
				/>
			</BaseButton>
		</View>
	);
}
