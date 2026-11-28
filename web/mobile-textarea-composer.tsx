import { suggestionMenuAction } from "../app/composer/composer-suggestion-keys";
import {
	cleanup,
	computed,
	createMotion,
	effect,
	Image,
	type InputRef,
	Overlay,
	Picker,
	platform,
	reduceMotion,
	Scroll,
	signal,
	Text,
	token,
	untracked,
	View,
	type ViewRef,
} from "nsh";
import { Button as BaseButton, Input as BaseInput } from "nsh/base";

import { fileMentionName } from "@shared/chat/chat-mentions";
import { formatChatImageSize } from "@shared/chat/chat-submission";
import {
	activeSuggestionQuery,
	FILE_SUGGESTION_LIMIT,
	piSessionSuggestions,
	TRIGGER_META,
	type ComposerSuggestion,
	type MentionTab,
} from "@shared/chat/composer-suggestions";
import { sessionMentionValue } from "@shared/chat/session-mentions";
import type { SendMessageShortcut } from "@shared/host-preferences-types";
import { webInputFontSize } from "@shared/web-font-scale";

import { t } from "../app/shell/i18n";
import {
	ChatMediaActions,
	chatAttachmentImage,
} from "../app/chat/chat-media-actions";
import { ChatReadingFont } from "../app/chat/chat-reading-font";
import { ComposerActions } from "../app/composer/composer-actions";
import { ComposerContextUsage } from "../app/composer/composer-context-usage";
import type { ComposerRunConfigProps } from "../app/composer/composer-run-config";
import type { ComposerStore } from "../app/composer/composer-store";
import { Button } from "../app/ui/button";
import { FileTypeIcon } from "../app/ui/file-type-icon";
import { Icon, type IconName } from "../app/ui/icon";
import { MOTION, tactileTransition } from "../app/ui/motion";
import { menuPopupClass, menuPopupStyle } from "../app/ui/menu";
import { menuRowClass } from "../app/ui/menu-row";
import { Skeleton } from "../app/ui/skeleton";
import { styleVar } from "../app/ui/theme-style";
import { MobileRunConfig } from "./mobile-run-config";
import { MobileViewport } from "./mobile-viewport";

const MAX_ROWS = 10;
const MIN_INPUT_HEIGHT = 48;

const SUGGESTION_ICONS: Record<ComposerSuggestion["kind"], IconName> = {
	file: "FileCode2",
	session: "MessageSquare",
	command: "TerminalSquare",
};

const composerShadow = () => styleVar("pilo-shadow-composer");

const focusShadow = () =>
	(styleVar as (name: string) => string | undefined)(
		"pilo-shadow-composer-focus",
	) ?? composerShadow();

function inputLineHeight(fontSize: number) {
	return Math.max(22, Math.round(fontSize * 1.4));
}

function clampInputHeight(
	contentHeight: number,
	leading: number,
	viewportHeight: number,
) {
	const minHeight = Math.max(MIN_INPUT_HEIGHT, leading * 2 + 4);
	const maxByRows = leading * MAX_ROWS + 8;
	const maxByViewport = Math.max(minHeight, Math.round(viewportHeight * 0.35));
	const maxHeight = Math.min(maxByRows, maxByViewport);
	if (contentHeight <= 0) return minHeight;
	return Math.max(minHeight, Math.min(Math.ceil(contentHeight + 8), maxHeight));
}

function clampLockedDraftHeight(
	contentHeight: number,
	leading: number,
	viewportHeight: number,
) {
	const minHeight = leading + 12;
	const maxByRows = leading * 4 + 12;
	const maxByViewport = Math.max(minHeight, Math.round(viewportHeight * 0.22));
	const maxHeight = Math.min(maxByRows, maxByViewport);
	if (contentHeight <= 0) return minHeight;
	return Math.max(minHeight, Math.min(Math.ceil(contentHeight + 8), maxHeight));
}

/** Startup loading skeleton aligned with `MobileTextareaComposer` geometry. */
export function MobileComposerSkeleton(props: { showModel?: boolean }) {
	return (
		<View
			class="relative w-full border border-(--pilo-composer-border) bg-(--pilo-composer-background)"
			style={{
				boxShadow: composerShadow(),
				borderRadius: token("pilo-mobile-composer-radius"),
				gap: 4,
				paddingHorizontal: 8,
				paddingVertical: 6,
			}}
		>
			<View class="px-1 pt-2" style={{ height: MIN_INPUT_HEIGHT }}>
				<Skeleton class="h-2.5 w-[42%] rounded-full" />
			</View>
			<View class="-ml-1 flex-row items-center gap-1 pt-0.5">
				<View class="h-10 w-8 shrink-0 items-center justify-center">
					<Skeleton class="size-4" />
				</View>
				{props.showModel ? (
					<View class="h-10 min-w-0 shrink flex-row items-center gap-1.5 px-1">
						<Skeleton class="size-4 shrink-0" />
						<Skeleton class="h-2.5 w-20 min-w-0 shrink rounded-full" />
					</View>
				) : null}
				<View class="ml-auto shrink-0 flex-row items-center gap-1">
					<View class="h-10 min-w-10 flex-row items-center justify-center gap-1 px-2">
						<Skeleton class="size-3.5" />
						<Skeleton class="size-3" />
					</View>
					<View class="size-11 shrink-0 items-center justify-center">
						<Skeleton strong class="size-8 rounded-full" />
					</View>
				</View>
			</View>
		</View>
	);
}

export interface MobileTextareaComposerProps {
	store: ComposerStore;
	sendShortcut?: () => SendMessageShortcut | undefined;
	runConfig?: ComposerRunConfigProps;
}

/**
 * Native `<textarea>` composer for nsh Web (`<Input multiline />`).
 * Aligns visually and interactively with the React WebUI mobile composer:
 * theme-driven composer surface, 40–44px touch targets, `@`/`/` suggestion
 * menu with touch and keyboard support, image/file attachments, and paste/drop.
 */
export function MobileTextareaComposer(props: MobileTextareaComposerProps) {
	const store = props.store;
	const readingFont = ChatReadingFont();
	const media = ChatMediaActions();
	const { availableHeight, requestSync } = MobileViewport();
	const surfaceWidth = signal(0);
	const toolbarWidth = signal(0);
	const surface = signal<ViewRef | undefined>(undefined);
	const inputRef = signal<InputRef | undefined>(undefined);
	const focused = signal(false);
	const contentHeight = signal(0);
	const caret = signal(0);
	const dismissedQuery = signal<string | null>(null);
	const mentionTab = signal<MentionTab>("file");
	const selectedIndex = signal(0);

	const state = () => store.state();
	const running = computed(() => store.running());
	const readOnly = () => store.readOnly();
	const config = () => props.runConfig?.config() ?? null;
	const headerMissing = () => Boolean(config()?.headerMissing);
	const locked = computed(() => readOnly() || headerMissing());
	const disabled = () => store.target() === null || locked();
	const blocked = () =>
		disabled() || state().sending || (running() && store.compacting());
	const modEnter = () => (props.sendShortcut?.() ?? "enter") === "mod-enter";
	const hasContent = () =>
		state().value.trim().length > 0 || state().images.length > 0;

	effect(() => {
		if (!running()) untracked(() => store.resetTransientSendMode());
	});

	effect(() => {
		if (locked()) focused.set(false);
	});

	const images = computed(() => state().images);
	const references = computed(() => store.mentionDraft().references);
	const hasAttachments = computed(
		() => images().length > 0 || references().length > 0,
	);
	const hasDraftText = computed(() => state().value.trim().length > 0);
	const hasDraft = computed(() => hasDraftText() || hasAttachments());
	const showInput = computed(() => !locked() || hasDraftText());

	// Reset local input measurements and menu dismissal when switching sessions.
	const targetKey = computed(() => store.target()?.sessionKey ?? null);
	effect(() => {
		targetKey();
		untracked(() => {
			contentHeight.set(0);
			dismissedQuery.set(null);
			selectedIndex.set(0);
			caret.set(store.state().value.length);
		});
	});

	// Track active `@` / `/` mention trigger from plain text + caret.
	const query = computed(() => {
		if (disabled()) return null;
		const value = state().value;
		const pos = Math.min(caret(), value.length);
		return activeSuggestionQuery(value, pos);
	});
	const queryKey = computed(() => {
		const active = query();
		return active
			? `${store.target()?.sessionKey ?? ""}:${active.start}:${active.trigger}:${active.query}`
			: null;
	});
	const menuOpen = computed(() => {
		const key = queryKey();
		return focused() && key !== null && key !== dismissedQuery();
	});

	effect(() => {
		if (!query()) dismissedQuery.set(null);
	});

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

	effect(() => {
		if (query()?.trigger === "/" && store.target()) {
			void store.loadCommands();
		}
	});

	const suggestionItems = computed<readonly ComposerSuggestion[]>(() => {
		const active = query();
		if (!active) return [];
		const needle = active.query.toLowerCase();
		const matches = (item: ComposerSuggestion) =>
			!needle ||
			[item.label, item.value, item.detail].some((part) =>
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
	});

	effect(() => {
		suggestionItems();
		selectedIndex.set(0);
	});

	const pickSuggestion = (suggestion: ComposerSuggestion | undefined) => {
		const active = query();
		if (!active || !suggestion) return;
		const current = state().value;
		const inserted = `${suggestion.value} `;
		const next = `${current.slice(0, active.start)}${inserted}${current.slice(active.end)}`;
		const nextCaret = active.start + inserted.length;
		store.setValue(next, nextCaret);
		caret.set(nextCaret);
		dismissedQuery.set(null);
		inputRef()?.focus();
	};

	const submit = () => {
		if (disabled() || state().composing) return;
		if (menuOpen() && suggestionItems().length > 0) {
			pickSuggestion(suggestionItems()[selectedIndex()]);
			return;
		}
		if (blocked()) return;
		void store.submit();
	};

	const pickAttachments = () => {
		const target = store.target();
		if (!target) return;
		const desktop = platform.desktop;
		if (!desktop) inputRef()?.blur();
		const pick = desktop
			? Picker.pickFiles({ multiple: true }).then((picked) =>
					picked.flatMap((entry) => (entry.file ? [entry.file] : [])),
				)
			: Picker.pickImages({ multiple: true })
					.finally(requestSync)
					.then((picked) => picked.map((entry) => entry.file));
		void pick
			.then((files) => {
				if (files.length > 0) return store.addFiles(files, target);
			})
			.catch((error: unknown) => {
				store.setStatus(
					error instanceof Error ? error.message : String(error),
					target.sessionKey,
				);
			});
	};

	const fontSize = () => webInputFontSize(readingFont().fontSize);
	const leading = () => inputLineHeight(fontSize());
	const height = () =>
		locked()
			? clampLockedDraftHeight(contentHeight(), leading(), availableHeight())
			: clampInputHeight(
					state().value ? contentHeight() : 0,
					leading(),
					availableHeight(),
				);

	// On phones/tablets, Return always inserts a newline to prevent accidental
	// sends during IME confirmation or touch typing; the Send button submits.
	const submitBehavior = () =>
		platform.desktop && !modEnter()
			? ("submit" as const)
			: ("newline" as const);

	const renderInput = () => (
		<View
			class={
				locked() && !hasAttachments() ? "border-t border-border/50" : undefined
			}
		>
			<BaseInput
				ref={(node) => inputRef.set(node)}
				testID="mobile-textarea-input"
				multiline
				value={state().value}
				disabled={disabled()}
				readonly={disabled()}
				placeholder={
					!hasAttachments() && !locked()
						? t("chat.composerPlaceholder")
						: undefined
				}
				accessibilityLabel={t("chat.composerPlaceholder")}
				submitBehavior={submitBehavior()}
				returnKeyType={platform.desktop && !modEnter() ? "send" : "default"}
				class={
					locked()
						? "min-w-0 w-full border-0 bg-transparent px-3 py-2 font-sans text-muted-foreground"
						: "min-w-0 w-full border-0 bg-transparent px-1 py-1 font-sans text-input-foreground placeholder:text-input-placeholder"
				}
				style={{
					height: height(),
					fontFamily: readingFont().fontFamily,
					fontSize: fontSize(),
					lineHeight: leading(),
				}}
				onChange={({ value }) => {
					if (disabled()) return;
					const prev = state().value;
					const delta = value.length - prev.length;
					const nextCaret = Math.max(
						0,
						Math.min(value.length, caret() + delta),
					);
					caret.set(nextCaret);
					store.setValue(value, nextCaret);
				}}
				onSelectionChange={({ end }) => {
					caret.set(end);
				}}
				onContentSizeChange={({ size }) => {
					contentHeight.set(size.height);
				}}
				onFocus={() => focused.set(true)}
				onBlur={() => focused.set(false)}
				onCompositionChange={({ composing }) => {
					store.setComposing(composing);
				}}
				onSubmit={() => {
					if (!state().composing) submit();
				}}
				onKeyDown={(event) => {
					if (state().composing) return;
					if (menuOpen()) {
						const entries = suggestionItems();
						const action = suggestionMenuAction(event.key, entries.length);
						if (action === "dismiss") {
							dismissedQuery.set(queryKey());
							return;
						}
						if (action === "next") {
							selectedIndex.update((i) => (i + 1) % entries.length);
							return;
						}
						if (action === "prev") {
							selectedIndex.update(
								(i) => (i - 1 + entries.length) % entries.length,
							);
							return;
						}
						if (action === "pick") {
							pickSuggestion(entries[selectedIndex()]);
							return;
						}
					}
					if (
						event.key === "Enter" &&
						(event.modifiers.platform || event.modifiers.control)
					) {
						submit();
					}
				}}
				onPaste={({ files, uris }) => {
					if (disabled()) return;
					if (files.length > 0) void store.addFiles(files);
					if (uris.length > 0) void store.addUris(uris);
				}}
			/>
		</View>
	);

	const renderEditableToolbar = () => (
		<View
			testID="chat-composer-toolbar"
			class="-ml-1 min-w-0 flex-row items-center gap-1 pt-0.5"
			onLayout={({ bounds }) => toolbarWidth.set(bounds.size.width)}
		>
			<Button
				testID="chat-composer-attach"
				variant="ghost"
				size="icon"
				class="size-10 shrink-0 rounded-md"
				disabled={blocked()}
				accessibilityLabel={
					platform.desktop ? t("chat.addAttachment") : t("chat.addImage")
				}
				onPress={pickAttachments}
			>
				<Icon name="Plus" size={16} />
			</Button>

			{props.runConfig ? (
				<MobileRunConfig
					{...props.runConfig}
					readOnly={() => locked()}
					toolbarWidth={toolbarWidth}
				/>
			) : null}

			{props.runConfig ? (
				<ComposerContextUsage
					usage={() => config()?.session ?? null}
					contextWindow={() => config()?.model?.contextWindow}
					touch
					availableHeight={availableHeight}
					onCompact={() => void store.compact()}
					compacting={() => store.compacting()}
					pendingCompact={() => store.pendingCompact()}
					onCancelPendingCompact={() => store.cancelPendingCompact()}
					compactDisabled={() => disabled() || state().sending}
				/>
			) : null}

			<ComposerActions
				toolbarWidth={toolbarWidth}
				sendMode={() => state().sendMode}
				onSendModeChange={(mode) => store.setSendMode(mode)}
				running={running}
				hasContent={hasContent}
				blocked={blocked}
				sending={() => state().sending}
				sendShortcut={() => (modEnter() ? "mod-enter" : "enter")}
				touch
				availableHeight={availableHeight}
				onSend={submit}
				onStop={() => void store.stop()}
			/>
		</View>
	);

	const renderLockedToolbar = () =>
		props.runConfig ? (
			<View
				testID="chat-composer-toolbar"
				class="min-w-0 flex-row items-center justify-between gap-2 border-t border-border/50 px-3"
				onLayout={({ bounds }) => toolbarWidth.set(bounds.size.width)}
			>
				<View class="min-w-0 flex-1 flex-row items-center pl-1">
					<MobileRunConfig
						{...props.runConfig}
						readOnly={() => true}
						toolbarWidth={toolbarWidth}
					/>
				</View>
				<View class="-mr-1.5 shrink-0">
					<ComposerContextUsage
						usage={() => config()?.session ?? null}
						contextWindow={() => config()?.model?.contextWindow}
						touch
						availableHeight={availableHeight}
						onCompact={() => void store.compact()}
						compacting={() => store.compacting()}
						pendingCompact={() => store.pendingCompact()}
						onCancelPendingCompact={() => store.cancelPendingCompact()}
						compactDisabled={() => disabled() || state().sending}
					/>
				</View>
			</View>
		) : null;

	return (
		<View
			testID="mobile-textarea-composer"
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
				state().status ? (
					<View
						testID="chat-composer-status"
						role="alert"
						class="mb-1.5 min-w-0 flex-row items-start justify-between gap-2 rounded-xl border border-border/60 bg-muted py-1.5 pl-3 pr-1.5"
					>
						<Text class="min-w-0 flex-1 py-0.5 font-sans text-xs text-(length:--pilo-ui-text-xs) leading-snug text-destructive">
							{() => state().status ?? ""}
						</Text>
						<Button
							testID="chat-composer-status-dismiss"
							variant="ghost"
							size="icon"
							class="size-10 shrink-0"
							accessibilityLabel={t("common.close")}
							onPress={() => store.setStatus(null)}
						>
							<Icon name="X" size={14} color={token("muted-foreground")} />
						</Button>
					</View>
				) : null
			}

			<View
				ref={(node) => surface.set(node)}
				testID="chat-composer-surface"
				onLayout={({ bounds }) => surfaceWidth.set(bounds.size.width)}
				class={
					headerMissing()
						? "relative w-full overflow-hidden border border-status-warning/30 bg-muted"
						: readOnly()
							? "relative w-full overflow-hidden border border-border/60 bg-muted"
							: "relative w-full border border-(--pilo-composer-border) bg-(--pilo-composer-background)"
				}
				style={{
					...tactileTransition("border-color, box-shadow, background-color"),
					borderColor:
						focused() && !locked()
							? token("pilo-composer-focus-border")
							: undefined,
					boxShadow: locked()
						? "none"
						: focused()
							? focusShadow()
							: composerShadow(),
					borderRadius: token("pilo-mobile-composer-radius"),
					gap: locked() ? 0 : 4,
					paddingHorizontal: locked() ? 0 : 8,
					paddingVertical: locked() ? 0 : 6,
				}}
			>
				{() =>
					headerMissing() ? (
						<View
							testID="chat-composer-header-missing"
							class="flex-row items-start gap-2 bg-status-warning/10 px-3 py-2.5"
						>
							<Icon
								name="TriangleAlert"
								size={14}
								class="mt-0.5 shrink-0"
								color={token("status-warning")}
							/>
							<Text class="min-w-0 flex-1 font-sans text-xs text-(length:--pilo-ui-text-xs) leading-snug text-status-warning">
								{() => t("chat.sessionHeaderMissing")}
							</Text>
						</View>
					) : readOnly() ? (
						<View
							testID="chat-composer-readonly"
							class="flex-row items-start gap-2 px-3 py-2.5"
						>
							<Icon
								name="Lock"
								size={14}
								class="mt-0.5 shrink-0"
								color={token("muted-foreground")}
								style={{ opacity: 0.8 }}
							/>
							<Text class="min-w-0 flex-1 font-sans text-xs text-(length:--pilo-ui-text-xs) leading-snug text-muted-foreground">
								{() =>
									hasDraft()
										? t("chat.externalReadOnly")
										: t("chat.externalReadOnlyIdle")
								}
							</Text>
						</View>
					) : null
				}
				{/* Attachment chips */}
				{() =>
					hasAttachments() ? (
						<View
							testID="chat-composer-attachments"
							class={
								locked()
									? "min-w-0 flex-row flex-wrap items-center gap-1.5 border-t border-border/50 px-2.5 py-2"
									: "min-w-0 flex-row flex-wrap items-center gap-1.5 p-1"
							}
						>
							<Each of={images()} key={(image) => image.id}>
								{(image) => (
									<View
										testID="chat-composer-image"
										class="min-h-10 max-w-full flex-row items-center gap-1 rounded-md border border-border/70 bg-muted/70 pl-2 pr-0.5"
									>
										<BaseButton
											class="min-h-10 min-w-0 flex-row items-center gap-1.5 py-1"
											accessibilityLabel={image().name}
											onPress={() =>
												media.openImage?.(chatAttachmentImage(image()))
											}
										>
											<Image
												src={`data:${image().mimeType};base64,${image().data}`}
												class="size-4 shrink-0 overflow-hidden rounded-[3px] border border-foreground/10"
												style={{ objectFit: "cover" }}
											/>
											<Text class="max-w-36 truncate font-sans text-xs text-(length:--pilo-ui-text-xs) leading-snug text-foreground">
												{`${image().name} · ${formatChatImageSize(image().size)}`}
											</Text>
										</BaseButton>
										<Button
											variant="ghost"
											size="icon"
											class="size-10 shrink-0"
											disabled={disabled()}
											accessibilityLabel={t("chat.removeAttachment", {
												name: image().name,
											})}
											onPress={() => {
												if (!disabled()) store.removeImage(image().id);
											}}
										>
											<Icon
												name="X"
												size={14}
												color={token("muted-foreground")}
											/>
										</Button>
									</View>
								)}
							</Each>
							<Each of={references()} key={(ref) => `${ref.kind}:${ref.path}`}>
								{(reference, index) => {
									const label = () => {
										const ref = reference();
										return ref.kind === "session"
											? ref.session.title
											: fileMentionName(ref.path);
									};
									return (
										<View class="min-h-10 max-w-full flex-row items-center gap-1 rounded-md border border-border/70 bg-muted/70 pl-2 pr-0.5">
											<BaseButton
												class="min-h-10 min-w-0 flex-row items-center gap-1.5"
												onPress={
													reference().kind === "file" && media.openFile
														? () => media.openFile?.(reference().path)
														: undefined
												}
											>
												{reference().kind === "session" ? (
													<Icon
														name="MessageSquare"
														size={13}
														color={token("muted-foreground")}
													/>
												) : (
													<FileTypeIcon path={reference().path} size={13} />
												)}
												<Text class="max-w-36 truncate font-sans text-xs text-(length:--pilo-ui-text-xs) leading-snug text-foreground">
													{label}
												</Text>
											</BaseButton>
											<Button
												variant="ghost"
												size="icon"
												class="size-10 shrink-0"
												disabled={disabled()}
												accessibilityLabel={t("chat.removeAttachment", {
													name: label(),
												})}
												onPress={() => {
													if (!disabled()) store.removeReference(index());
												}}
											>
												<Icon
													name="X"
													size={14}
													color={token("muted-foreground")}
												/>
											</Button>
										</View>
									);
								}}
							</Each>
						</View>
					) : null
				}

				{/* Native browser <textarea> via nsh/base Input multiline; collapsed when locked without a draft */}
				{() => (showInput() ? untracked(renderInput) : null)}

				{/* Bottom toolbar: full controls when editable; compact metadata row when locked */}
				{() =>
					locked()
						? untracked(renderLockedToolbar)
						: untracked(renderEditableToolbar)
				}
			</View>

			{/* `@` / `/` suggestions popup */}
			{() => {
				if (!menuOpen()) return null;
				const suggestMotion = createMotion({
					enter: reduceMotion()
						? {
								keyframes: { opacity: [0, 1] },
								duration: 80,
								easing: MOTION.easing.standardTuple,
							}
						: {
								keyframes: {
									opacity: [0, 1],
									translateY: [4, 0],
									scale: [0.98, 1],
								},
								duration: MOTION.duration.surfaceIn,
								easing: MOTION.easing.standardTuple,
							},
				});
				cleanup(() => suggestMotion.stop());
				return (
					<Overlay
						anchor={surface()}
						placement="top"
						align="start"
						offset={6}
						onCancel={() => dismissedQuery.set(queryKey())}
					>
						<View
							testID="chat-composer-suggestions"
							class={`${menuPopupClass} min-w-0 overflow-hidden`}
							style={[
								menuPopupStyle(),
								suggestMotion.style,
								{ width: Math.min(surfaceWidth() || 320, 480) },
							]}
						>
							{() =>
								query()?.trigger === "@" ? (
									<View class="mb-1 flex-row gap-1 border-b border-border/50 pb-1">
										{(
											[
												{ id: "file", label: () => t("chat.fileSuggestion") },
												{
													id: "session",
													label: () => t("chat.sessionSuggestion"),
												},
											] as const
										).map((tab) => (
											<BaseButton
												class={`min-h-9 flex-1 items-center justify-center rounded-md px-2 ${
													mentionTab() === tab.id ? "bg-hover" : ""
												}`}
												onPress={() => mentionTab.set(tab.id)}
											>
												<Text class="font-sans text-xs text-(length:--pilo-ui-text-xs) leading-snug font-medium text-foreground">
													{tab.label}
												</Text>
											</BaseButton>
										))}
									</View>
								) : null
							}
							<Scroll
								bounces={false}
								contentClass="gap-1"
								style={{ maxHeight: Math.min(220, availableHeight() * 0.35) }}
							>
								{() => {
									const entries = suggestionItems();
									const active = query();
									const title =
										active?.trigger === "@" && mentionTab() === "session"
											? t("chat.sessionSuggestion")
											: t(TRIGGER_META[active?.trigger ?? "@"].titleKey);
									if (entries.length === 0) {
										return (
											<Text class="px-3 py-4 text-center font-sans text-xs text-(length:--pilo-ui-text-xs) leading-snug text-muted-foreground">
												{active?.query
													? t("chat.noSuggestionMatch", {
															query: active.query,
															title,
														})
													: t("chat.noSuggestionAvailable", { title })}
											</Text>
										);
									}
									return (
										<View class="gap-0.5">
											{entries.map((entry, idx) => (
												<BaseButton
													class={`${menuRowClass} min-h-11 active:bg-hover ${
														selectedIndex() === idx ? "bg-hover" : ""
													}`}
													style={tactileTransition("background-color, color")}
													onPress={() => pickSuggestion(entry)}
												>
													<Icon
														name={SUGGESTION_ICONS[entry.kind]}
														size={14}
														color={token("muted-foreground")}
													/>
													<View class="min-w-0 flex-1">
														<Text class="truncate font-sans text-xs text-(length:--pilo-ui-text-xs) leading-snug font-medium text-foreground">
															{entry.label}
														</Text>
														{entry.detail ? (
															<Text class="truncate font-sans text-xs text-(length:--pilo-ui-text-2xs) leading-tight text-muted-foreground">
																{entry.detail}
															</Text>
														) : null}
													</View>
												</BaseButton>
											))}
										</View>
									);
								}}
							</Scroll>
						</View>
					</Overlay>
				);
			}}
		</View>
	);
}
