import {
	type JSX,
	Overlay,
	Picker,
	platform,
	Scroll,
	type ScrollRef,
	Text,
	View,
	type ViewRef,
	cleanup,
	computed,
	createMotion,
	effect,
	reduceMotion,
	signal,
	token,
	untracked,
	windowSize,
} from "nsh";

import { userErrorMessage } from "@shared/app-error";
import {
	fileMentionPath,
	prepareMentionDraftForEnhancement,
	restoreMentionDraftFromEnhancement,
} from "@shared/chat/chat-mentions";
import {
	FILE_SUGGESTION_LIMIT,
	TRIGGER_META,
	piSessionSuggestions,
	type ComposerSuggestion,
	type MentionTab,
} from "@shared/chat/composer-suggestions";
import { sessionMentionValue } from "@shared/chat/session-mentions";
import type { SendMessageShortcut } from "@shared/host-preferences-types";
import { normalizeKeyboardShortcut } from "@shared/keyboard-shortcuts-core";
import { formatKeyboardShortcutLabels } from "@shared/keyboard-shortcuts-format";
import type { KeyboardShortcutMap } from "@shared/keyboard-shortcuts-types";

import { AppToaster, showToast } from "../shell/app-toasts";
import { t } from "../shell/i18n";
import { ChatReadingFont } from "../chat/chat-reading-font";
import { chatMetadataText, chatPx } from "../chat/layout";
import { bindAppShortcut } from "../shortcuts";
import { Button } from "../ui/button";
import { FileTypeIcon } from "../ui/file-type-icon";
import { createHover } from "../ui/hover";
import { Icon, type IconName } from "../ui/icon";
import { menuPopupClass, menuPopupStyle } from "../ui/menu";
import { menuRowClass } from "../ui/menu-row";
import { MOTION, tactileTransition } from "../ui/motion";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { styleVar } from "../ui/theme-style";
import { Tooltip } from "../ui/tooltip";
import { ComposerActions } from "./composer-actions";
import type { ComposerAssistance } from "./composer-assistance";
import { ComposerContextUsage } from "./composer-context-usage";
import {
	composerActionsGap,
	composerRunConfigStyle,
	composerSendModeStyle,
	composerSendSize,
	composerToolbarGap,
	composerToolButtonSize,
} from "./composer-layout";
import {
	ComposerRunConfig,
	type ComposerRunConfigProps,
} from "./composer-run-config";
import type { RichSuggestionMatch } from "./composer-rich-doc";
import {
	ComposerRichInput,
	type ComposerRichInputHandle,
} from "./composer-rich-input";
import type { ComposerStore } from "./composer-store";

/** The React composer grows to 12 lines, then scrolls. */
const MAX_ROWS = 12;
const INPUT_HINT_HEIGHT = chatPx(28);

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
	"relative w-full border border-(--pilo-composer-border) bg-(--pilo-composer-background)";
/** A read-only chat's composer, dimmed as the WebUI composer's `muted` surface. */
const COMPOSER_SURFACE_MUTED =
	"relative w-full border border-border/60 bg-muted";
const COMPOSER_TOOLBAR = "min-w-0 flex-row items-center";

function surfaceStyle(focused: boolean, muted = false) {
	return {
		...tactileTransition("border-color, box-shadow, background-color"),
		borderColor:
			focused && !muted ? token("pilo-composer-focus-border") : undefined,
		boxShadow: focused && !muted ? focusShadow() : composerShadow(),
		borderRadius: chatPx(token("pilo-composer-radius")),
		gap: chatPx(token("pilo-composer-gap")),
		paddingHorizontal: chatPx(8),
		paddingVertical: chatPx(6),
	};
}

function toolbarStyle() {
	return {
		marginLeft: -chatPx(4),
		gap: composerToolbarGap(),
		paddingTop: chatPx(2),
	};
}

const inputMinHeight = () => chatPx(token("pilo-composer-input-height"));

function inputLineHeight(fontSize: number) {
	return Math.max(chatPx(20), Math.round(fontSize * 1.35));
}

function inputHeight(contentHeight: number, leading: number, padding: number) {
	// Keep the theme minimum or two native lines, whichever is taller, as in the WebUI.
	return Math.max(
		inputMinHeight(),
		Math.ceil(leading * 2 + padding * 2),
		Math.min(
			Math.ceil(contentHeight + padding * 2),
			leading * MAX_ROWS + padding * 2,
		),
	);
}

/** The empty composer's geometry, without mounting input or menu behavior. */
export function ChatComposerSkeleton(props: { showModel: boolean }) {
	const toolbarWidth = signal(0);
	return (
		<View class={COMPOSER_SURFACE} style={surfaceStyle(false)}>
			<View class="px-1 pt-2" style={{ height: inputMinHeight() }}>
				<Skeleton class="h-[9px] w-[42%] rounded-full" />
			</View>
			<View
				class={COMPOSER_TOOLBAR}
				style={toolbarStyle()}
				onLayout={({ bounds }) => toolbarWidth.set(bounds.size.width)}
			>
				<View
					class="shrink-0 items-center justify-center"
					style={composerToolButtonSize()}
				>
					<Skeleton style={{ width: chatPx(16), height: chatPx(16) }} />
				</View>
				{props.showModel ? (
					<View
						class="min-w-0 shrink flex-row items-center"
						style={composerRunConfigStyle(toolbarWidth())}
					>
						<Skeleton
							class="shrink-0"
							style={{ width: chatPx(16), height: chatPx(16) }}
						/>
						<Skeleton
							class="min-w-0 shrink rounded-full"
							style={{ width: chatPx(80), height: chatPx(10) }}
						/>
					</View>
				) : null}
				<View
					class="ml-auto shrink-0 flex-row items-center"
					style={{ gap: composerActionsGap(toolbarWidth()) }}
				>
					<View class="flex-row items-center" style={composerSendModeStyle()}>
						<Skeleton style={{ width: chatPx(14), height: chatPx(14) }} />
						<Skeleton style={{ width: chatPx(12), height: chatPx(12) }} />
					</View>
					<Skeleton strong class="rounded-full" style={composerSendSize()} />
				</View>
			</View>
		</View>
	);
}

export interface ChatComposerProps {
	/** The open chat's composer state and actions. */
	store: ComposerStore;
	assistance?: ComposerAssistance;
	/** Null suspends session shortcuts while a dialog or command palette is open. */
	shortcuts?: () => KeyboardShortcutMap | null;
	onInputFocusChange?: (focused: boolean) => void;
	/** Focus the matching editor once, when its chat is visible. */
	focusRequest?: { sessionKey: () => string | null; handled: () => void };
	/** The configured submit shortcut; Enter submits by default. */
	sendShortcut?: () => SendMessageShortcut | undefined;
	/** The model · thinking control; the toolbar leaves it out without one. */
	runConfig?: ComposerRunConfigProps;
}

/**
 * The prompt bar under a chat: a growing multiline inline-mention editor with
 * `@` file and session mentions, `/` commands, picked, pasted and dropped
 * attachments in one unified compact row, per-project drafts and input history,
 * and send or stop.
 */
export function ChatComposer(props: ChatComposerProps) {
	const store = props.store;
	const readingFont = ChatReadingFont();
	const surfaceWidth = signal(0);
	const toolbarWidth = signal(0);
	const index = signal(0);
	const dismissedQuery = signal<string | null>(null);
	const contentHeight = signal(0);
	const focused = signal(false);
	const focusShortcutLabels = signal<string[]>([]);
	const surface = signal<ViewRef | undefined>(undefined);
	const activeSuggestion = signal<RichSuggestionMatch | null>(null);
	let inputHandle: ComposerRichInputHandle | undefined;

	const state = () => store.state();
	const composing = computed(() => state().composing);
	const readOnly = () => store.readOnly();
	const headerMissing = () => props.runConfig?.config()?.headerMissing === true;
	const disabled = () =>
		store.target() === null || readOnly() || headerMissing();
	const editing = computed(() => focused() && !disabled());
	const running = () => store.running();
	// 会话空闲时复位一次性 `send_now`。
	effect(() => {
		if (!running()) store.resetTransientSendMode();
	});
	const onInputFocusChange = props.onInputFocusChange;
	if (onInputFocusChange) {
		effect(() => onInputFocusChange(editing()));
		cleanup(() => onInputFocusChange(false));
	}
	const modEnter = () => (props.sendShortcut?.() ?? "enter") === "mod-enter";
	const hasContent = () =>
		state().value.trim().length > 0 || state().images.length > 0;
	const sessionsByValue = () => store.sessionsByValue();

	const inputLeading = () => inputLineHeight(readingFont().fontSize);
	const inputPadding = () => chatPx(2);

	const query = computed<RichSuggestionMatch | null>(() => activeSuggestion(), {
		equals: (previous, next) =>
			previous?.trigger === next?.trigger &&
			previous?.start === next?.start &&
			previous?.end === next?.end &&
			previous?.query === next?.query &&
			previous?.docRange.from === next?.docRange.from &&
			previous?.docRange.to === next?.docRange.to,
	});
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
			return [...piSessionSuggestions(t), ...store.commands()].filter(matches);
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
		inputHandle?.focus();
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
	const canPickSuggestion = () => menuOpen() && items().length > 0;

	effect(() => {
		items();
		index.set(0);
	});
	effect(() => {
		if (!query()) {
			dismissedQuery.set(null);
			mentionNavigation.set(null);
		}
	});

	effect(() => {
		const shortcut = props.shortcuts?.()?.["focus-composer"];
		const binding =
			shortcut && store.target() && !(focused() && composing())
				? bindAppShortcut(
						"focus-composer",
						shortcut,
						() => inputHandle?.focus(),
						editing(),
					)
				: undefined;
		const isMac = platform.os === "macos";
		const normalized = binding && normalizeKeyboardShortcut(shortcut, isMac);
		focusShortcutLabels.set(
			normalized ? formatKeyboardShortcutLabels(normalized, isMac) : [],
		);
		if (binding) cleanup(binding.dispose);
	});
	effect(() => {
		const map = props.shortcuts?.();
		if (!map || !editing() || composing() || !running() || store.compacting())
			return;
		const binding = bindAppShortcut(
			"queue-message",
			map["queue-message"],
			() => void store.submit("follow_up", inputHandle?.submissionText()),
			true,
		);
		if (binding) cleanup(binding.dispose);
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
		if (!suggestion || !active || !inputHandle) return;
		if (suggestion.kind === "file") {
			const path = fileMentionPath(suggestion.value);
			if (path) {
				inputHandle.insertMentionAt(active.docRange, { kind: "file", path });
				return;
			}
		}
		if (suggestion.kind === "session") {
			const session = sessionsByValue().get(suggestion.value);
			if (session) {
				inputHandle.insertMentionAt(active.docRange, {
					kind: "session",
					path: session.path,
					session,
				});
				return;
			}
		}
		inputHandle.insertTextAt(active.docRange, `${suggestion.value} `);
	};

	const handleMenuKey = (
		key: "ArrowUp" | "ArrowDown" | "Tab" | "Enter" | "Escape",
	) => {
		const active = query();
		if (!active || !menuOpen()) return;
		if (key === "Escape") {
			dismissSuggestions();
			return;
		}
		const list = items();
		const count = list.length;
		const onTabs = categoryFocused();
		if (key === "Tab") {
			if (onTabs) {
				changeMentionTab(mentionTab() === "file" ? "session" : "file");
			} else if (count) {
				pick(list[index()]);
			}
			return;
		}
		if (key === "Enter") {
			if (count) pick(list[onTabs ? 0 : index()]);
			return;
		}
		if (key === "ArrowDown" && count) {
			enterCandidates();
			index.update((i) => (onTabs ? 0 : (i + 1) % count));
			return;
		}
		if (key === "ArrowUp") {
			if (active.trigger === "@" && !onTabs && index() === 0) {
				changeMentionTab(mentionTab());
			} else if (count) {
				enterCandidates();
				index.update((i) => (onTabs ? count - 1 : (i - 1 + count) % count));
			}
		}
	};

	const submit = () => {
		if (canPickSuggestion()) return;
		if (hasContent() && !state().composing) props.assistance?.dismiss();
		void store.submit(undefined, inputHandle?.submissionText());
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

	const images = computed(() => state().images);
	const references = computed(() => store.mentionDraft().references);
	const hasAttachments = computed(
		() => images().length > 0 || references().length > 0,
	);

	const showFocusHint = () =>
		platform.desktop &&
		!focused() &&
		!ghostText() &&
		!disabled() &&
		!state().value &&
		!hasAttachments() &&
		focusShortcutLabels().length > 0;
	const focusRequest = props.focusRequest;
	if (focusRequest) {
		const readyFocusRequest = () => {
			const key = focusRequest.sessionKey();
			return key === store.target()?.sessionKey && !disabled() ? key : null;
		};
		effect(() => {
			const key = readyFocusRequest();
			if (!key) return;
			// The editor is keyed by session; wait for the new native view to mount.
			const frame = requestAnimationFrame(() => {
				if (readyFocusRequest() !== key || !inputHandle) return;
				inputHandle.focus();
				focusRequest.handled();
			});
			return () => cancelAnimationFrame(frame);
		});
	}
	const blocked = () =>
		disabled() || state().sending || (running() && store.compacting());
	const config = () => props.runConfig?.config() ?? null;

	const assistance = props.assistance;
	const ghostText = () =>
		state().composing ? null : (assistance?.result()?.text ?? null);
	/**
	 * Whether Tab adopts the suggestion wherever the keyboard focus is: in the
	 * editor (its ghost plugin) and, from the chat beside it, as an app binding.
	 */
	const canAdoptWithTab = () =>
		!menuOpen() && props.shortcuts?.() !== null && !!ghostText();
	const inputRightPadding = () => {
		if (ghostText()) return canAdoptWithTab() ? 80 : 112;
		return showFocusHint() ? 64 : 4;
	};
	const adoptSuggestion = () => {
		const text = ghostText();
		if (!text || menuOpen()) return;
		assistance?.dismiss();
		if (inputHandle) {
			inputHandle.replaceValueWithHistory(text);
			inputHandle.focusEnd();
		} else {
			store.setValue(text);
		}
	};
	const handleGhostKey = (key: "Tab" | "Escape") => {
		if (key === "Tab") adoptSuggestion();
		else assistance?.dismiss();
	};
	// A focused text input keeps Tab for itself, so the editor adopts through its
	// plugin; the rest of the window goes through an app binding.
	effect(() => {
		const binding =
			!focused() && canAdoptWithTab()
				? bindAppShortcut("focus-composer", "tab", adoptSuggestion)
				: undefined;
		if (binding) cleanup(binding.dispose);
	});

	const toasts = AppToaster();
	const enhancing = signal(false);
	const enhancedUndo = signal<{ sessionKey: string; previous: string } | null>(
		null,
	);
	let enhanceSequence = 0;
	const enhanceLabel = () =>
		t(enhancing() ? "chat.cancelEnhancePrompt" : "chat.enhancePrompt");
	const enhanceDisabled = () =>
		!enhancing() &&
		(blocked() || state().composing || !store.mentionDraft().text.trim());
	let disposed = false;
	cleanup(() => {
		disposed = true;
	});
	// 切换会话时自动隐藏「撤销优化」条并复位进行中的草稿优化态。
	let lastEnhanceTargetKey: string | null = store.target()?.sessionKey ?? null;
	effect(() => {
		const targetKey = store.target()?.sessionKey ?? null;
		const undo = enhancedUndo();
		if (undo && undo.sessionKey !== targetKey) enhancedUndo.set(null);
		if (targetKey !== lastEnhanceTargetKey) {
			lastEnhanceTargetKey = targetKey;
			if (untracked(enhancing)) {
				enhanceSequence += 1;
				enhancing.set(false);
			}
		}
	});
	const undoEnhancedDraft = () => {
		const undo = enhancedUndo();
		if (!undo || undo.sessionKey !== store.target()?.sessionKey) return;
		enhancedUndo.set(null);
		if (inputHandle) {
			inputHandle.replaceValueWithHistory(undo.previous);
			inputHandle.focusEnd();
		} else {
			store.setValue(undo.previous);
		}
	};
	const enhanceDraft = async () => {
		if (enhancing()) {
			enhanceSequence += 1;
			enhancing.set(false);
			return;
		}
		if (!assistance?.canEnhance() || enhanceDisabled()) return;
		const targetKey = store.target()?.sessionKey ?? null;
		if (!targetKey) return;
		const rawValue = state().value;
		const prepared = prepareMentionDraftForEnhancement(
			rawValue,
			sessionsByValue(),
		);
		const revision = store.draftRevision;
		const requestId = ++enhanceSequence;
		const stillCurrent = () =>
			!disposed &&
			requestId === enhanceSequence &&
			store.draftRevision === revision &&
			!state().composing &&
			!disabled() &&
			props.shortcuts?.() !== null &&
			assistance.canEnhance();
		assistance.dismiss();
		enhancedUndo.set(null);
		enhancing.set(true);
		try {
			const text = (await assistance.enhance(prepared.text.trim())).trim();
			if (!text || !stillCurrent()) return;
			const value = restoreMentionDraftFromEnhancement(
				text,
				prepared.placeholders,
			);
			if (inputHandle) {
				inputHandle.replaceValueWithHistory(value);
				inputHandle.focusEnd();
			} else {
				store.setValue(value);
			}
			enhancedUndo.set({ sessionKey: targetKey, previous: rawValue });
		} catch (error: unknown) {
			if (stillCurrent())
				showToast(toasts, {
					variant: "error",
					title: t("chat.enhancePromptFailed"),
					description: userErrorMessage(error),
				});
		} finally {
			if (!disposed && requestId === enhanceSequence) enhancing.set(false);
		}
	};

	const placeholder = () =>
		headerMissing()
			? t("chat.sessionHeaderMissing")
			: readOnly()
				? t("chat.externalReadOnly")
				: (ghostText() ??
					(!hasAttachments() ? t("chat.composerPlaceholder") : undefined));

	return (
		<View
			testID="chat-composer"
			class="relative w-full"
			onFileDragEnter={() => {
				if (!disabled()) store.setDragging(true);
			}}
			onFileDragLeave={() => store.setDragging(false)}
			onFileDrop={({ uris }) => {
				store.setDragging(false);
				if (!disabled()) void store.addUris(uris);
			}}
		>
			{() =>
				headerMissing() ? (
					<View
						testID="chat-composer-header-missing"
						role="alert"
						class="mb-2 min-w-0 flex-row items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2"
					>
						<Icon
							name="TriangleAlert"
							class="mt-0.5 shrink-0"
							size={14}
							color={token("destructive")}
						/>
						<Text class="min-w-0 flex-1 font-sans text-xs leading-5 text-destructive">
							{() => t("chat.sessionHeaderMissing")}
						</Text>
					</View>
				) : readOnly() ? (
					<View
						testID="chat-composer-readonly-notice"
						class="mb-2 min-w-0 flex-row items-center gap-2 rounded-xl border border-border/60 bg-muted px-3 py-1.5"
					>
						<Icon name="Lock" size={13} color={token("muted-foreground")} />
						<Text class="min-w-0 flex-1 font-sans text-xs leading-5 text-muted-foreground">
							{() => t("chat.externalReadOnly")}
						</Text>
					</View>
				) : null
			}
			{() =>
				state().status ? (
					<View
						testID="chat-composer-status"
						role="alert"
						class="mb-2 min-w-0 flex-row items-start gap-2 rounded-xl border border-border/60 bg-muted px-3 py-2"
					>
						<View selectable class="min-w-0 flex-1">
							<Text class="font-sans text-xs leading-5 text-destructive">
								{() => state().status ?? ""}
							</Text>
						</View>
						<Button
							testID="chat-composer-status-dismiss"
							variant="ghost"
							size="icon"
							class="-my-1 size-7 shrink-0"
							accessibilityLabel={t("common.close")}
							onPress={() => store.setStatus(null)}
						>
							<Icon name="X" size={14} color={token("muted-foreground")} />
						</Button>
					</View>
				) : null
			}
			{() =>
				enhancedUndo() &&
				enhancedUndo()?.sessionKey === store.target()?.sessionKey ? (
					<View
						testID="chat-composer-enhance-undo"
						class="mb-2 min-w-0 flex-row items-center justify-between gap-2 rounded-xl border border-border/60 bg-muted px-3 py-1.5"
					>
						<View class="flex-row items-center gap-2">
							<Icon
								name="PencilSparkles"
								size={13}
								color={token("muted-foreground")}
							/>
							<Text class="font-sans text-xs text-muted-foreground">
								{() => t("chat.enhancedDraftNotice")}
							</Text>
						</View>
						<View class="flex-row items-center gap-1">
							<Button
								testID="chat-composer-enhance-undo-action"
								variant="ghost"
								size="sm"
								class="h-6 px-2"
								onPress={undoEnhancedDraft}
							>
								<Text class="font-sans text-xs font-medium text-foreground">
									{() => t("chat.undoEnhancePrompt")}
								</Text>
							</Button>
							<Button
								variant="ghost"
								size="icon"
								class="size-6"
								accessibilityLabel={t("common.close")}
								onPress={() => enhancedUndo.set(null)}
							>
								<Icon name="X" size={13} color={token("muted-foreground")} />
							</Button>
						</View>
					</View>
				) : null
			}
			{() =>
				!state().status && assistance?.result()?.unavailable ? (
					<View
						testID="chat-composer-suggestion-unavailable"
						role="alert"
						class="mb-2 min-w-0 flex-row items-start gap-2.5 rounded-xl border border-border/60 bg-muted px-3 py-2"
					>
						<Icon
							name="TriangleAlert"
							class="mt-0.5"
							size={14}
							color={token("status-warning")}
						/>
						<Text class="min-w-0 flex-1 font-sans text-xs leading-5 text-muted-foreground">
							{t("settings.nextPromptUnavailable")}
						</Text>
						<Button
							variant="ghost"
							size="icon"
							class="-my-1 size-7 shrink-0"
							accessibilityLabel={t("common.close")}
							onPress={assistance.dismiss}
						>
							<Icon name="X" size={14} color={token("muted-foreground")} />
						</Button>
					</View>
				) : null
			}
			<View
				ref={(ref) => surface.set(ref)}
				testID="chat-composer-surface"
				onLayout={({ bounds }) => surfaceWidth.set(bounds.size.width)}
				class={disabled() ? COMPOSER_SURFACE_MUTED : COMPOSER_SURFACE}
				style={surfaceStyle(focused(), disabled())}
			>
				<View class="relative min-w-0 flex-row items-start">
					<ComposerRichInput
						testID="chat-composer-input"
						sessionKey={() => store.target()?.sessionKey ?? null}
						projectId={() => store.target()?.projectId ?? null}
						value={() => state().value}
						images={() => images()}
						sessionsByValue={sessionsByValue}
						readingFont={readingFont}
						disabled={disabled}
						placeholder={placeholder}
						accessibilityLabel={() => t("chat.composerPlaceholder")}
						height={() =>
							inputHeight(
								state().value || state().images.length > 0
									? contentHeight()
									: 0,
								inputLeading(),
								inputPadding(),
							)
						}
						paddingVertical={inputPadding}
						paddingRight={inputRightPadding}
						modEnter={modEnter}
						menuOpen={menuOpen}
						canPickSuggestion={canPickSuggestion}
						canAdoptGhost={canAdoptWithTab}
						canNavigateHistory={() => store.canNavigateHistory()}
						onHandle={(handle) => {
							inputHandle = handle;
							focused.set(false);
							activeSuggestion.set(null);
							return () => {
								// Each mounts the new editor before disposing the old one.
								if (inputHandle !== handle) return;
								inputHandle = undefined;
								focused.set(false);
								activeSuggestion.set(null);
							};
						}}
						onValueChange={(nextValue) => {
							if (!disabled()) {
								enhancedUndo.set(null);
								store.setValue(nextValue);
							}
						}}
						onRemoveImage={(id) => {
							if (!disabled()) store.removeImage(id);
						}}
						onRemoveMention={(kind, path) => {
							if (!disabled()) store.removeMention(kind, path);
						}}
						onSuggestionChange={(match) => activeSuggestion.set(match)}
						onContentHeightChange={(height) => contentHeight.set(height)}
						onFocusChange={(isFocused) => focused.set(isFocused)}
						onCompositionChange={(composing) => store.setComposing(composing)}
						onSubmit={submit}
						onMenuKey={handleMenuKey}
						onHistoryKey={(direction) => {
							void store.navigateHistory(direction);
						}}
						onGhostKey={handleGhostKey}
						onPasteFiles={(files, uris) => {
							if (!disabled()) store.addPastedFiles(files, uris);
						}}
					/>
					{() => {
						const suggestion = ghostText();
						return suggestion ? (
							<Button
								testID="chat-composer-adopt-suggestion"
								variant="ghost"
								size="sm"
								class="absolute right-0 z-10"
								style={{
									height: INPUT_HINT_HEIGHT,
									gap: chatPx(6),
									paddingHorizontal: chatPx(8),
									top:
										(inputLineHeight(readingFont().fontSize) -
											INPUT_HINT_HEIGHT) /
										2,
								}}
								accessibilityLabel={t("chat.adoptNextPrompt", {
									text: suggestion,
								})}
								onPress={adoptSuggestion}
							>
								<Text
									class="font-sans text-muted-foreground"
									style={{ fontSize: chatPx(12) }}
								>
									{canAdoptWithTab() ? "→" : t("chat.acceptNextPrompt")}
								</Text>
								{canAdoptWithTab() ? <ComposerKeyHint label="Tab" /> : null}
							</Button>
						) : null;
					}}
					{() =>
						showFocusHint() ? (
							<View
								class="absolute right-0 top-0 z-10 flex-row items-center"
								style={{
									height: inputLineHeight(readingFont().fontSize),
									gap: chatPx(2),
									opacity: 0.7,
									pointerEvents: "none",
								}}
								accessibilityElementsHidden
							>
								{focusShortcutLabels().map((label, index) => (
									<>
										{index > 0 ? (
											<Text
												class="font-mono text-muted-foreground"
												style={chatMetadataText}
											>
												+
											</Text>
										) : null}
										<ComposerKeyHint label={label} />
									</>
								))}
							</View>
						) : null
					}
				</View>
				<View
					testID="chat-composer-toolbar"
					class={COMPOSER_TOOLBAR}
					style={toolbarStyle()}
					onLayout={({ bounds }) => toolbarWidth.set(bounds.size.width)}
				>
					<Button
						testID="chat-composer-attach"
						variant="ghost"
						size="icon"
						class="shrink-0"
						style={composerToolButtonSize()}
						disabled={blocked()}
						accessibilityLabel={t("chat.addAttachment")}
						tooltip={
							<Tooltip>
								<Text class="font-sans">{() => t("chat.addAttachment")}</Text>
							</Tooltip>
						}
						onPress={pickFiles}
					>
						<Icon
							name="Plus"
							size={chatPx(16)}
							color={token("muted-foreground")}
						/>
					</Button>
					{props.runConfig ? (
						<ComposerRunConfig
							{...props.runConfig}
							readOnly={() => readOnly() || headerMissing()}
							toolbarWidth={toolbarWidth}
						/>
					) : null}
					{props.runConfig ? (
						<ComposerContextUsage
							usage={() => config()?.session ?? null}
							contextWindow={() => config()?.model?.contextWindow}
							onCompact={() => void store.compact()}
							compacting={() => store.compacting()}
							pendingCompact={() => store.pendingCompact()}
							onCancelPendingCompact={() => store.cancelPendingCompact()}
							compactDisabled={() => disabled() || state().sending}
						/>
					) : null}
					<ComposerActions
						toolbarWidth={toolbarWidth}
						beforeSendMode={() =>
							assistance?.canEnhance() ? (
								<Button
									testID="chat-composer-enhance"
									variant="ghost"
									size="icon"
									style={composerToolButtonSize()}
									disabled={enhanceDisabled()}
									accessibilityLabel={enhanceLabel()}
									tooltip={
										<Tooltip>
											<Text class="font-sans">{enhanceLabel}</Text>
										</Tooltip>
									}
									onPress={() => void enhanceDraft()}
								>
									{() =>
										enhancing() ? (
											<Spinner
												size={chatPx(14)}
												color={token("muted-foreground")}
											/>
										) : (
											<Icon
												name="PencilSparkles"
												size={chatPx(16)}
												color={token("muted-foreground")}
											/>
										)
									}
								</Button>
							) : null
						}
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
				{() => {
					if (!state().dragging) return null;
					const dropMotion = createMotion({
						enter: reduceMotion()
							? undefined
							: {
									keyframes: { opacity: [0, 1] },
									duration: MOTION.duration.tactile,
									easing: MOTION.easing.standardTuple,
								},
					});
					cleanup(() => dropMotion.stop());
					return (
						<View
							testID="chat-composer-drop"
							class="absolute inset-0 z-20 items-center justify-center bg-background/90 px-3"
							style={[
								dropMotion.style,
								{ borderRadius: chatPx(token("pilo-composer-radius")) },
							]}
						>
							<Text class="font-sans text-sm text-foreground">
								{() => t("chat.dropFiles")}
							</Text>
						</View>
					);
				}}
			</View>
			{() => {
				if (!focused()) return null;
				// A click on a non-focusable view doesn't blur native inputs on Windows.
				return (
					<Overlay
						anchor={surface()}
						style={{ width: 0, height: 0, pointerEvents: "box-none" }}
						onPressOutside={() => inputHandle?.blur()}
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
	const enterMotion = createMotion({
		enter: reduceMotion()
			? {
					keyframes: { opacity: [0, 1] },
					duration: 80,
					easing: MOTION.easing.standardTuple,
				}
			: {
					keyframes: { opacity: [0, 1], translateY: [4, 0], scale: [0.98, 1] },
					duration: MOTION.duration.surfaceIn,
					easing: MOTION.easing.standardTuple,
				},
	});
	cleanup(() => enterMotion.stop());
	return (
		<View
			testID="chat-composer-suggestions"
			class={`${menuPopupClass} min-w-0 overflow-hidden`}
			style={[
				menuPopupStyle(),
				enterMotion.style,
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
				bounces={false}
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
						const filePath =
							suggestion.kind === "file"
								? (fileMentionPath(suggestion.value) ?? suggestion.label)
								: null;
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
								style={tactileTransition("background-color, color")}
								onMouseEnter={() => props.onHighlight(i)}
								onPress={() => props.onPick(suggestion)}
							>
								<View class="size-3.5 shrink-0 items-center justify-center">
									{filePath ? (
										<FileTypeIcon path={filePath} size={12} />
									) : (
										<Icon
											name={
												suggestion.skill
													? "Sparkles"
													: SUGGESTION_ICONS[suggestion.kind]
											}
											size={12}
											color={token("muted-foreground")}
										/>
									)}
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

function ComposerKeyHint(props: { label: string }) {
	return (
		<View
			class="shrink-0 rounded-[4px] border border-border/70 bg-muted/50"
			style={{ paddingHorizontal: chatPx(4), paddingVertical: 1 }}
		>
			<Text class="font-mono text-muted-foreground" style={chatMetadataText}>
				{props.label}
			</Text>
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
						<ComposerKeyHint label="Tab" />
						<Text class="min-w-0 shrink truncate font-sans text-[11px] text-muted-foreground">
							{() => t("chat.mentionTabSwitchHint")}
						</Text>
					</View>
				) : null
			}
		</View>
	);
}
