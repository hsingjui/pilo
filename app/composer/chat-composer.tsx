import {
	Image,
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
	effect,
	signal,
	token,
	windowSize,
} from "nsh";
import { Button as BaseButton } from "nsh/base";

import { userErrorMessage } from "@shared/app-error";
import {
	fileMentionName,
	fileMentionPath,
	writeChatMentionDraft,
} from "@shared/chat/chat-mentions";
import { formatChatImageSize } from "@shared/chat/chat-submission";
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
import {
	ChatMediaActions,
	chatAttachmentImage,
} from "../chat/chat-media-actions";
import { ChatReadingFont } from "../chat/chat-reading-font";
import { chatMetadataText, chatPx } from "../chat/layout";
import { bindAppShortcut, type AppShortcutBinding } from "../shortcuts";
import { Button } from "../ui/button";
import { FileTypeIcon } from "../ui/file-type-icon";
import { blurOnPointerPress, focusRingStyle } from "../ui/focus-ring-style";
import { createHover } from "../ui/hover";
import { Icon, type IconName } from "../ui/icon";
import { menuPopupClass, menuPopupStyle } from "../ui/menu";
import { menuRowClass } from "../ui/menu-row";
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
	appShortcuts?: () => readonly AppShortcutBinding[];
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
	const media = ChatMediaActions();
	const readingFont = ChatReadingFont();
	const surfaceWidth = signal(0);
	const toolbarWidth = signal(0);
	const index = signal(0);
	const dismissedQuery = signal<string | null>(null);
	const contentHeight = signal(0);
	const focused = signal(false);
	const focusShortcutLabels = signal<string[]>([]);
	const focusShortcutBinding = signal<AppShortcutBinding>();
	const queueShortcutBinding = signal<AppShortcutBinding>();
	const surface = signal<ViewRef | undefined>(undefined);
	const activeSuggestion = signal<RichSuggestionMatch | null>(null);
	let inputHandle: ComposerRichInputHandle | undefined;

	const state = () => store.state();
	const running = () => store.running();
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
			shortcut && store.target()
				? bindAppShortcut("focus-composer", shortcut, () =>
						inputHandle?.focus(),
					)
				: undefined;
		const isMac = platform.os === "macos";
		const normalized = binding && normalizeKeyboardShortcut(shortcut, isMac);
		focusShortcutLabels.set(
			normalized ? formatKeyboardShortcutLabels(normalized, isMac) : [],
		);
		focusShortcutBinding.set(binding);
		if (binding) cleanup(binding.dispose);
	});
	effect(() => {
		const map = props.shortcuts?.();
		const binding =
			map && focused() && running() && !store.compacting()
				? bindAppShortcut(
						"queue-message",
						map["queue-message"],
						() => void store.submit("follow_up", inputHandle?.submissionText()),
					)
				: undefined;
		queueShortcutBinding.set(binding);
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
		!readOnly() &&
		!state().value &&
		!hasAttachments() &&
		focusShortcutLabels().length > 0;
	const readOnly = () => store.readOnly();
	const disabled = () => store.target() === null || readOnly();
	const blocked = () =>
		disabled() || state().sending || (running() && store.compacting());
	const config = () => props.runConfig?.config() ?? null;

	const assistance = props.assistance;
	const ghostText = () =>
		state().composing ? null : (assistance?.result()?.text ?? null);
	const canAdoptWithTab = () =>
		focused() && !menuOpen() && props.shortcuts?.() !== null && !!ghostText();
	const inputRightPadding = () => {
		if (ghostText()) return canAdoptWithTab() ? 80 : 112;
		return showFocusHint() ? 64 : 4;
	};
	const adoptSuggestion = () => {
		const text = ghostText();
		if (!text || menuOpen()) return;
		assistance?.dismiss();
		store.setValue(text);
		inputHandle?.focusEnd();
	};
	const handleGhostKey = (key: "Tab" | "Escape") => {
		if (key === "Tab") adoptSuggestion();
		else assistance?.dismiss();
	};

	const toasts = AppToaster();
	const enhancing = signal(false);
	const enhanceLabel = () =>
		t(enhancing() ? "chat.enhancingPrompt" : "chat.enhancePrompt");
	const enhanceDisabled = () =>
		blocked() ||
		state().composing ||
		enhancing() ||
		!store.mentionDraft().text.trim();
	let disposed = false;
	cleanup(() => {
		disposed = true;
	});
	const enhanceDraft = async () => {
		if (!assistance?.canEnhance() || enhanceDisabled()) return;
		const draft = store.mentionDraft();
		const revision = store.draftRevision;
		const stillCurrent = () =>
			!disposed &&
			store.draftRevision === revision &&
			!state().composing &&
			!readOnly() &&
			props.shortcuts?.() !== null &&
			assistance.canEnhance();
		assistance.dismiss();
		enhancing.set(true);
		try {
			const text = (await assistance.enhance(draft.text.trim())).trim();
			if (!text || !stillCurrent()) return;
			const value = writeChatMentionDraft(draft.references, text);
			store.setValue(value);
			inputHandle?.focusEnd();
		} catch (error: unknown) {
			if (stillCurrent())
				showToast(toasts, {
					variant: "error",
					title: t("chat.enhancePromptFailed"),
					description:
						(error instanceof Error
							? error.message
							: typeof error === "string"
								? error
								: "") || userErrorMessage(error),
				});
		} finally {
			if (!disposed) enhancing.set(false);
		}
	};

	const placeholder = () =>
		readOnly()
			? t("chat.externalReadOnly")
			: (ghostText() ??
				(!hasAttachments() ? t("chat.composerPlaceholder") : undefined));

	return (
		<View
			testID="chat-composer"
			class="relative w-full"
			onFileDragEnter={() => {
				if (!readOnly()) store.setDragging(true);
			}}
			onFileDragLeave={() => store.setDragging(false)}
			onFileDrop={({ uris }) => {
				store.setDragging(false);
				if (!readOnly()) void store.addUris(uris);
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
				class={readOnly() ? COMPOSER_SURFACE_MUTED : COMPOSER_SURFACE}
				style={surfaceStyle(focused(), readOnly())}
			>
				{() =>
					hasAttachments() ? (
						<View
							testID="chat-composer-attachments"
							class="min-w-0 flex-row flex-wrap items-center"
							style={{
								marginBottom: chatPx(4),
								gap: chatPx(6),
								padding: chatPx(4),
							}}
						>
							<Each of={images()} key={(image) => image.id}>
								{(image) => (
									<AttachmentChip
										testID="chat-composer-image"
										label={image().name}
										tooltip={`${image().name} · ${formatChatImageSize(image().size)}`}
										removeLabel={t("chat.removeAttachment", {
											name: image().name,
										})}
										leading={
											<Image
												src={`data:${image().mimeType};base64,${image().data}`}
												class="shrink-0 overflow-hidden rounded-[3px] border border-foreground/10"
												style={{
													width: chatPx(16),
													height: chatPx(16),
													objectFit: "cover",
												}}
											/>
										}
										disabled={disabled()}
										onPress={
											media.openImage
												? () => media.openImage?.(chatAttachmentImage(image()))
												: undefined
										}
										onRemove={() => {
											if (!disabled()) store.removeImage(image().id);
										}}
									/>
								)}
							</Each>
							<Each of={references()} key={(ref) => `${ref.kind}:${ref.path}`}>
								{(reference, index) => {
									const name = () => {
										const ref = reference();
										return ref.kind === "session"
											? ref.session.title
											: fileMentionName(ref.path);
									};
									const tooltip = () => {
										const ref = reference();
										return ref.kind === "session" && ref.session.projectName
											? `${ref.session.projectName}\n${ref.path}`
											: ref.path;
									};
									return (
										<AttachmentChip
											testID={`chat-composer-attachment:${reference().kind}`}
											label={name()}
											tooltip={tooltip()}
											removeLabel={t("chat.removeAttachment", { name: name() })}
											leading={
												reference().kind === "session" ? (
													<Icon
														name="MessageSquare"
														size={chatPx(13)}
														color={token("muted-foreground")}
													/>
												) : (
													<FileTypeIcon
														path={reference().path}
														size={chatPx(13)}
													/>
												)
											}
											disabled={disabled()}
											onPress={
												reference().kind === "file" && media.openFile
													? () => media.openFile?.(reference().path)
													: undefined
											}
											onRemove={() => {
												if (!disabled()) store.removeReference(index());
											}}
										/>
									);
								}}
							</Each>
						</View>
					) : null
				}
				<View class="relative min-w-0 flex-row items-start">
					<ComposerRichInput
						testID="chat-composer-input"
						sessionKey={() => store.target()?.sessionKey ?? null}
						projectId={() => store.target()?.projectId ?? null}
						value={() => (readOnly() ? "" : state().value)}
						images={() => (readOnly() ? [] : images())}
						sessionsByValue={sessionsByValue}
						readingFont={readingFont}
						disabled={disabled}
						placeholder={placeholder}
						accessibilityLabel={() => t("chat.composerPlaceholder")}
						height={() =>
							inputHeight(
								(state().value || state().images.length > 0) && !readOnly()
									? contentHeight()
									: 0,
								inputLeading(),
								inputPadding(),
							)
						}
						paddingVertical={inputPadding}
						paddingRight={inputRightPadding}
						modEnter={modEnter}
						shortcuts={() => [
							...(props.appShortcuts?.() ?? []),
							focusShortcutBinding(),
							queueShortcutBinding(),
						]}
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
							if (!readOnly()) store.setValue(nextValue);
						}}
						onRemoveImage={(id) => {
							if (!readOnly()) store.removeImage(id);
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
							if (readOnly()) return;
							if (files.length) void store.addFiles(files);
							if (uris.length) void store.addUris(uris);
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
							readOnly={readOnly}
							toolbarWidth={toolbarWidth}
						/>
					) : null}
					{props.runConfig ? (
						<ComposerContextUsage
							usage={() => config()?.session ?? null}
							contextWindow={() => config()?.model?.contextWindow}
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
				{() =>
					state().dragging ? (
						<View
							testID="chat-composer-drop"
							class="absolute inset-0 z-20 items-center justify-center bg-background/90 px-3"
							style={{ borderRadius: chatPx(token("pilo-composer-radius")) }}
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

/** 统一单行附件芯片：上传图片、上传文件、`@文件` 与 `@会话` 共用同一套外观与交互。 */
function AttachmentChip(props: {
	testID?: string;
	label: string;
	tooltip?: string;
	removeLabel: string;
	leading: JSX.Element;
	onPress?: () => void;
	disabled?: boolean;
	onRemove: () => void;
}) {
	const removeHover = createHover();
	const readingFont = ChatReadingFont();
	const openBlur = blurOnPointerPress();
	const removeBlur = blurOnPointerPress();
	return (
		<View
			testID={props.testID}
			class="min-w-0 flex-row items-center rounded-md bg-muted/60"
			style={{
				height: Math.max(chatPx(28), inputLineHeight(readingFont().fontSize)),
				maxWidth: chatPx(216),
			}}
		>
			<BaseButton
				ref={openBlur.ref}
				onMouseUp={openBlur.onMouseUp}
				class={`h-full min-w-0 flex-1 flex-row items-center rounded-l-md transition-colors focus-visible:outline-hidden ${props.onPress ? "hover:bg-hover" : ""}`}
				style={{
					gap: chatPx(6),
					paddingLeft: chatPx(8),
					paddingRight: chatPx(6),
					cursor: props.onPress ? "pointer" : "default",
				}}
				focusVisibleStyle={focusRingStyle(token("ring"))}
				accessibilityLabel={props.label}
				tooltip={
					props.tooltip ? (
						<Tooltip class="max-w-96" delay={250} margin={12}>
							<Text class="font-mono text-xs">{props.tooltip}</Text>
						</Tooltip>
					) : undefined
				}
				onPress={props.onPress}
			>
				{props.leading}
				<Text
					class="min-w-0 shrink truncate font-sans text-foreground"
					style={{ fontSize: chatPx(12) }}
				>
					{() => props.label}
				</Text>
			</BaseButton>
			<BaseButton
				ref={removeBlur.ref}
				onMouseUp={removeBlur.onMouseUp}
				class="h-full shrink-0 items-center justify-center rounded-r-md transition-colors hover:bg-hover focus-visible:outline-hidden"
				style={{ width: chatPx(24), cursor: "pointer" }}
				focusVisibleStyle={focusRingStyle(token("ring"))}
				accessibilityLabel={props.removeLabel}
				disabled={props.disabled}
				{...removeHover.props}
				onPress={props.onRemove}
			>
				<Icon
					name="X"
					size={chatPx(12)}
					color={token(
						removeHover.hovered() ? "foreground" : "muted-foreground",
					)}
				/>
			</BaseButton>
		</View>
	);
}
