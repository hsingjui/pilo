import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
} from "react";
import {
	isImeComposingKeyboardEvent,
	isImeComposingNativeKeyboardEvent,
} from "@/lib/ime";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { LoaderCircle, PencilSparkles, Plus, X } from "lucide-react";

import { FileMentionBadge } from "@/components/chat/path-mention-badge";
import { SessionMentionBadge } from "@/components/chat/session-mention-badge";
import { discardRemovedChatFiles } from "@/lib/chat/chat-file-lifecycle";
import {
	fileMentionPath,
	fileMentionName,
	readChatMentionDraft,
	writeChatMentionDraft,
} from "@/lib/chat/chat-mentions";
import {
	useSessionMentions,
	useSessionMentionDrag,
} from "@/components/chat/session-mention-context";
import {
	sessionMentionValue,
	type SessionMention,
} from "@/lib/chat/session-mentions";
import { ChatImageThumbnail } from "@/components/chat/chat-image-viewer";

import { formatKeyboardShortcut } from "@/lib/keyboard-shortcuts";
import {
	runtimeErrorMessage,
	type PiModel,
	type PiThinkingLevel,
} from "@/lib/api/pi-runtime";
import type { ModelScopeControls } from "@/lib/project-model-scope";
import { cn } from "@/lib/utils";
import { getPageFontFamilyStack } from "@/lib/font-settings";
import { usePreferences } from "@/lib/preferences-provider";
import {
	type ChatImageAttachment,
	type ChatSubmission,
} from "@/lib/chat/chat-submission";
import {
	Button,
	NoticeCard,
	Spinner,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
	Textarea,
} from "@/ui";
import { ComposerActions } from "@/components/chat/chat-composer-actions";
import { ComposerContextUsage } from "@/components/chat/composer-context-usage";
import type { ChatSessionRuntimeState } from "@/components/chat/chat-page-utils";
import {
	CHAT_COMPOSER_ATTACHMENT_BUTTON_CLASS_NAME,
	CHAT_COMPOSER_TEXTAREA_CLASS_NAME,
	CHAT_COMPOSER_TOOLBAR_CLASS_NAME,
	ChatComposerRoot,
	ChatComposerSurface,
} from "@/components/chat/chat-composer-frame";
import { ComposerRunConfig } from "@/components/chat/chat-composer-run-config";
import { useChatComposerAttachments } from "@/components/chat/use-chat-composer-attachments";
import { useChatComposerInput } from "@/components/chat/use-chat-composer-input";
import {
	ComposerSuggestionMenu,
	DEFAULT_SUGGESTIONS,
	type ComposerSuggestion,
} from "@/components/chat/chat-composer-suggestions";

export type {
	ComposerSuggestion,
	ComposerSuggestionKind,
} from "@/components/chat/chat-composer-suggestions";

type ChatComposerProps = {
	value: string;
	onChange: (value: string) => void;
	images?: readonly ChatImageAttachment[];
	onImagesChange?: (images: ChatImageAttachment[]) => void;
	onUploadFile?: (file: File) => Promise<string>;
	attachmentScopeKey?: string | null;
	onSubmit?: (submission: ChatSubmission) => void;
	onSteer?: (submission: ChatSubmission) => void;
	onFollowUp?: (submission: ChatSubmission) => void;
	onSendNow?: (submission: ChatSubmission) => Promise<void>;
	placeholder?: string;
	disabled?: boolean;
	muted?: boolean;
	running?: boolean;
	onStop?: () => void;
	pendingFollowUps?: number;
	statusText?: string;
	statusError?: string | null;
	compacting?: boolean;
	retrying?: boolean;
	onAbortRetry?: () => void;
	contextUsage?: ChatSessionRuntimeState | null;
	models?: readonly PiModel[];
	modelScope?: ModelScopeControls;
	canEditScope?: boolean;
	selectedModel?: PiModel | null;
	modelLoading?: boolean;
	modelError?: string | null;
	modelDisabled?: boolean;
	onModelMenuOpen?: () => void;
	onModelRefresh?: () => void;
	onModelChange?: (model: PiModel | null) => void;
	thinkingLevels?: readonly PiThinkingLevel[];
	selectedThinkingLevel?: PiThinkingLevel | null;
	thinkingLoading?: boolean;
	thinkingDisabled?: boolean;
	onThinkingMenuOpen?: () => void;
	onThinkingChange?: (level: PiThinkingLevel | null) => void;
	suggestions?: readonly ComposerSuggestion[];
	onSuggestionTrigger?: (trigger: "@" | "/" | null, query: string) => void;
	historyKey?: string | null;
	className?: string;
	nextPrompt?: string | null;
	onNextPromptDismiss?: () => void;
	/** 桌面专属的快捷键提示与自动聚焦；Remote WebUI 传 false。 */
	desktopShortcuts?: boolean;
	/**
	 * 用一次性 Pi 进程改写草稿；只有当前 Connection 打开该功能时才传入。
	 * 桌面与 Remote WebUI 共用。
	 */
	onEnhancePrompt?: (draft: string) => Promise<string>;
};

const EMPTY_MODELS: readonly PiModel[] = [];
const EMPTY_THINKING_LEVELS: readonly PiThinkingLevel[] = [];

export function ChatComposer({
	value,
	onChange,
	images,
	onImagesChange,
	onUploadFile,
	attachmentScopeKey,
	onSubmit,
	onSteer,
	onFollowUp,
	onSendNow,
	placeholder,
	disabled = false,
	muted = false,
	running = false,
	onStop,
	pendingFollowUps = 0,
	statusText = "",
	statusError = null,
	compacting = false,
	retrying = false,
	onAbortRetry,
	contextUsage = null,
	models = EMPTY_MODELS,
	modelScope,
	canEditScope = true,
	selectedModel = null,
	modelLoading = false,
	modelError = null,
	modelDisabled = false,
	onModelMenuOpen,
	onModelRefresh,
	onModelChange,
	thinkingLevels = EMPTY_THINKING_LEVELS,
	selectedThinkingLevel = null,
	thinkingLoading = false,
	thinkingDisabled = false,
	onThinkingMenuOpen,
	onThinkingChange,
	suggestions = DEFAULT_SUGGESTIONS,
	onSuggestionTrigger,
	historyKey,
	className,
	nextPrompt,
	onNextPromptDismiss,
	desktopShortcuts = true,
	onEnhancePrompt,
}: ChatComposerProps) {
	const { t } = useTranslation();
	const composerPlaceholder = placeholder ?? t("chat.composerPlaceholder");
	const rootRef = useRef<HTMLDivElement>(null);
	const { mentions, byValue, connectionId } = useSessionMentions();
	const mentionDrag = useSessionMentionDrag();
	const mentionDraft = useMemo(
		() => readChatMentionDraft(value, byValue),
		[value, byValue],
	);
	const changeDraft = useCallback(
		(next: string) => {
			onChange(next);
			discardRemovedChatFiles(value, next);
		},
		[onChange, value],
	);
	const allSuggestions = useMemo(
		() => [
			...suggestions,
			...[...mentions]
				// oxlint-disable-next-line unicorn/no-array-sort -- Sort a local clone; the app targets ES2020.
				.sort((a, b) => b.updatedAt - a.updatedAt)
				.map((mention): ComposerSuggestion => ({
					kind: "session",
					value: sessionMentionValue(mention.path),
					label: mention.title,
					detail: mention.projectName,
				})),
		],
		[suggestions, mentions],
	);

	const {
		keyboardShortcuts,
		sendMessageShortcut,
		readingFontSize,
		readingFontFamily,
	} = usePreferences();
	const {
		fileInputRef,
		attachments,
		updateImages,
		handleFiles,
		handlePaste,
		processing,
		dragging,
	} = useChatComposerAttachments({
		images,
		onImagesChange,
		onUploadFile,
		scopeKey: attachmentScopeKey ?? historyKey,
		disabled,
		rootRef,
		onFilesAdded: (paths) => {
			onNextPromptDismiss?.();
			changeDraft(
				writeChatMentionDraft(
					[
						...mentionDraft.references,
						...paths.map((path) => ({ kind: "file" as const, path })),
					],
					mentionDraft.text,
				),
			);
		},
	});
	const {
		sendMode,
		setSendMode,
		sendingNow,
		canSubmit,
		editorRef,
		newlineOnEnter,
		showFocusHint,
		suggestionMenuOpen,
		activeQuery,
		queryMeta,
		filteredSuggestions,
		effectiveHighlightedIndex,
		suggestionMenuId,
		mentionTab,
		categoryFocused,
		changeMentionTab,
		highlightSuggestion,
		selectSuggestion,
		handleKeyDown,
		syncCaret,
		submit,
		onFieldChange,
	} = useChatComposerInput({
		value: mentionDraft.text,
		submissionText: value,
		onHistoryValue: changeDraft,
		onChange: (text) =>
			changeDraft(writeChatMentionDraft(mentionDraft.references, text)),
		onMentionSelect: (suggestion, text) => {
			const session = byValue.get(suggestion.value);
			const path = fileMentionPath(suggestion.value);
			if (suggestion.kind === "session" && session)
				addSessionMention(session, text);
			else if (suggestion.kind === "file" && path) {
				onNextPromptDismiss?.();
				changeDraft(
					writeChatMentionDraft(
						[...mentionDraft.references, { kind: "file", path }],
						text,
					),
				);
			}
		},
		attachments,
		selectedModel,
		disabled,
		submitBlocked: processing,
		compacting,
		running,
		onSubmit,
		onSteer,
		onFollowUp,
		onSendNow,
		suggestions: allSuggestions,
		onSuggestionTrigger,
		historyKey,
		desktopShortcuts,
	});

	const addSessionMention = useCallback(
		(mention: SessionMention, text = mentionDraft.text) => {
			if (
				mention.connectionId !== connectionId ||
				!byValue.has(sessionMentionValue(mention.path))
			)
				return;
			onNextPromptDismiss?.();
			changeDraft(
				writeChatMentionDraft(
					[
						...mentionDraft.references,
						{ kind: "session", path: mention.path, session: mention },
					],
					text,
				),
			);
		},
		[connectionId, byValue, onNextPromptDismiss, mentionDraft, changeDraft],
	);

	const removeLastMention = useCallback(
		(textarea: HTMLTextAreaElement) => {
			if (
				disabled ||
				sendingNow ||
				textarea.selectionStart !== 0 ||
				textarea.selectionEnd !== 0 ||
				mentionDraft.references.length === 0
			)
				return false;
			onNextPromptDismiss?.();
			changeDraft(
				writeChatMentionDraft(
					mentionDraft.references.slice(0, -1),
					mentionDraft.text,
				),
			);
			return true;
		},
		[disabled, sendingNow, mentionDraft, changeDraft, onNextPromptDismiss],
	);

	useLayoutEffect(() => {
		const textarea = editorRef.current;
		if (!textarea) return;
		// Mobile keyboards may emit only beforeinput; bind before paint so remounts cannot miss it.
		const handleBeforeInput = (event: InputEvent) => {
			if (
				event.inputType !== "deleteContentBackward" ||
				event.isComposing ||
				!event.cancelable
			)
				return;
			if (removeLastMention(textarea)) event.preventDefault();
		};
		textarea.addEventListener("beforeinput", handleBeforeInput);
		return () => textarea.removeEventListener("beforeinput", handleBeforeInput);
		// oxlint-disable-next-line react/exhaustive-effect-dependencies -- Scope changes remount the keyed textarea, so its native listener must be rebound.
	}, [editorRef, removeLastMention, attachmentScopeKey, historyKey]);

	useEffect(() => {
		const element = rootRef.current;
		if (
			!element ||
			!mentionDrag ||
			!connectionId ||
			disabled ||
			sendingNow ||
			processing
		)
			return;
		return mentionDrag.register(element, {
			connectionId,
			insert: (mention) => {
				addSessionMention(mention);
				editorRef.current?.focus({ preventScroll: true });
			},
		});
	}, [
		mentionDrag,
		connectionId,
		disabled,
		sendingNow,
		processing,
		addSessionMention,
		editorRef,
	]);

	const ghostText =
		!value &&
		!attachments.length &&
		!processing &&
		!disabled &&
		!running &&
		!compacting &&
		!sendingNow
			? nextPrompt
			: null;
	const adoptNextPrompt = useCallback(() => {
		if (!ghostText) return;
		onNextPromptDismiss?.();
		changeDraft(writeChatMentionDraft(mentionDraft.references, ghostText));
		editorRef.current?.focus();
	}, [
		ghostText,
		onNextPromptDismiss,
		editorRef,
		changeDraft,
		mentionDraft.references,
	]);

	// 草稿优化：只在草稿未被改动时回填，避免覆盖用户在等待期间的新输入。
	const [enhancing, setEnhancing] = useState(false);
	const enhancingRef = useRef(false);
	// 每次草稿或归属变化都创建新快照，切走再切回也不能恢复旧请求。
	const draftSnapshotRef = useRef<object | null>(null);
	useLayoutEffect(() => {
		draftSnapshotRef.current = {
			value,
			attachments,
			attachmentScopeKey,
			historyKey,
		};
		return () => {
			draftSnapshotRef.current = null;
		};
	}, [value, attachments, attachmentScopeKey, historyKey]);
	const enhanceDraft = mentionDraft.text.trim();
	const enhanceDisabled =
		!onEnhancePrompt ||
		disabled ||
		sendingNow ||
		processing ||
		enhancing ||
		!enhanceDraft;

	async function handleEnhancePrompt() {
		if (enhanceDisabled || enhancingRef.current || !onEnhancePrompt) return;
		const references = mentionDraft.references;
		const startSnapshot = draftSnapshotRef.current;
		const isCurrent = () => draftSnapshotRef.current === startSnapshot;
		enhancingRef.current = true;
		setEnhancing(true);
		try {
			const enhanced = (await onEnhancePrompt(enhanceDraft)).trim();
			// 期间草稿有任何变化（正文、引用或附件）就放弃回填，避免覆盖用户输入；
			// 回填走 changeDraft，让被替换掉的引用按既有规则清理附件。
			if (enhanced && isCurrent()) {
				changeDraft(writeChatMentionDraft(references, enhanced));
			}
		} catch (error) {
			if (!isCurrent()) return;
			const detail =
				error instanceof Error
					? error.message
					: typeof error === "string"
						? error
						: runtimeErrorMessage(error);
			toast.error(t("chat.enhancePromptFailed"), {
				description: detail || runtimeErrorMessage(error),
			});
		} finally {
			enhancingRef.current = false;
			if (draftSnapshotRef.current) setEnhancing(false);
			if (isCurrent()) editorRef.current?.focus();
		}
	}

	useEffect(() => {
		if (!ghostText || suggestionMenuOpen) return;
		const handleTab = (event: KeyboardEvent) => {
			if (
				event.key !== "Tab" ||
				event.defaultPrevented ||
				event.repeat ||
				event.shiftKey ||
				event.ctrlKey ||
				event.metaKey ||
				event.altKey ||
				isImeComposingNativeKeyboardEvent(event)
			)
				return;
			// Leave focus navigation to any control or overlay the user is using.
			if (
				(document.activeElement && document.activeElement !== document.body) ||
				window.getSelection()?.isCollapsed === false ||
				document.querySelector(
					'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
				)
			)
				return;
			event.preventDefault();
			adoptNextPrompt();
		};
		window.addEventListener("keydown", handleTab);
		return () => window.removeEventListener("keydown", handleTab);
	}, [ghostText, suggestionMenuOpen, adoptNextPrompt]);

	return (
		<ChatComposerRoot
			className={cn(className, dragging && "ring-2 ring-ring")}
			elementRef={rootRef}
		>
			{dragging ? (
				<output className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-composer bg-background/90 px-3 text-sm text-foreground">
					{t("chat.dropFiles")}
				</output>
			) : null}
			{suggestionMenuOpen && activeQuery && queryMeta ? (
				<ComposerSuggestionMenu
					menuId={suggestionMenuId}
					mentionTab={mentionTab}
					categoryFocused={categoryFocused}
					onMentionTabChange={changeMentionTab}
					activeQuery={activeQuery}
					title={t(queryMeta.titleKey)}
					suggestions={filteredSuggestions}
					highlightedIndex={effectiveHighlightedIndex}
					onHighlight={highlightSuggestion}
					onSelect={selectSuggestion}
				/>
			) : null}

			{statusText || statusError || (retrying && onAbortRetry) ? (
				<NoticeCard
					announce={statusError ? "alert" : "status"}
					ariaLive="polite"
					className="mb-2 px-3 py-2"
				>
					<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
						{statusText ? (
							<span className="min-w-0 flex-1 break-words tabular-nums text-muted-foreground">
								{statusText}
							</span>
						) : null}
						{retrying && onAbortRetry ? (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="ml-auto -mr-2 h-7 shrink-0 px-2 text-xs text-muted-foreground pointer-coarse:h-11"
								onClick={onAbortRetry}
							>
								{t("chat.stopRetry")}
							</Button>
						) : null}
					</div>
					{statusError ? (
						<div className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-xs leading-5 text-destructive [overflow-wrap:anywhere]">
							{statusError}
						</div>
					) : null}
				</NoticeCard>
			) : null}

			<ChatComposerSurface muted={muted}>
				<div
					className="relative min-w-0"
					style={
						{
							"--pilo-composer-line-height": `max(1.25rem, ${readingFontSize * 1.25}px)`,
						} as CSSProperties
					}
				>
					{attachments.length > 0 || mentionDraft.references.length > 0 ? (
						<div
							data-chat-composer-attachments=""
							data-chat-composer-references=""
							className={cn(
								"mb-1 flex max-h-[min(8rem,25dvh,var(--pilo-composer-attachments-max-height,8rem))] min-w-0 flex-wrap items-center gap-1.5 overflow-y-auto overscroll-contain",
								attachments.length > 0 ? "p-1" : "px-1",
							)}
						>
							{attachments.map((attachment) => (
								<div
									key={attachment.id}
									data-chat-composer-image=""
									className="relative inline-flex shrink-0 items-center"
								>
									<ChatImageThumbnail
										className="size-11"
										image={{
											id: attachment.id,
											name: attachment.name,
											mimeType: attachment.mimeType,
											size: attachment.size,
											source: "local",
										}}
									/>
									<button
										type="button"
										disabled={disabled || sendingNow || processing}
										aria-label={t("chat.removeAttachment", {
											name: attachment.name,
										})}
										className={cn(
											"absolute -right-0.5 -top-0.5 z-10 inline-flex size-5 items-center justify-center rounded-full pointer-coarse:static pointer-coarse:min-h-11 pointer-coarse:min-w-11",
											"border border-border/70 bg-background text-muted-foreground shadow-sm transition-colors pointer-coarse:border-0 pointer-coarse:bg-transparent pointer-coarse:shadow-none",
											"hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
											(disabled || sendingNow || processing) && "opacity-60",
										)}
										onClick={() =>
											updateImages(
												attachments.filter((item) => item.id !== attachment.id),
											)
										}
									>
										<X className="size-3" />
									</button>
								</div>
							))}
							{mentionDraft.references.map((mention, index) => (
								<span
									key={`${mention.kind}:${mention.path}`}
									data-chat-composer-reference=""
									className="inline-flex min-w-0 max-w-full items-center gap-0.5"
								>
									{mention.kind === "session" ? (
										<SessionMentionBadge mention={mention.session} compact />
									) : (
										<FileMentionBadge path={mention.path} compact />
									)}
									<button
										type="button"
										disabled={disabled || sendingNow}
										className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
										aria-label={
											mention.kind === "session"
												? t("chat.removeSessionMention", {
														title: mention.session.title,
													})
												: t("chat.removeAttachment", {
														name: fileMentionName(mention.path),
													})
										}
										onClick={() => {
											onNextPromptDismiss?.();
											changeDraft(
												writeChatMentionDraft(
													mentionDraft.references.filter((_, i) => i !== index),
													mentionDraft.text,
												),
											);
											editorRef.current?.focus({ preventScroll: true });
										}}
									>
										<X className="size-3" aria-hidden="true" />
									</button>
								</span>
							))}
						</div>
					) : null}
					<div className="relative min-w-0">
						<Textarea
							data-chat-composer-input=""
							key={attachmentScopeKey ?? historyKey}
							ref={editorRef}
							enterKeyHint={
								!newlineOnEnter && sendMessageShortcut === "enter"
									? "send"
									: "enter"
							}
							value={mentionDraft.text}
							rows={1}
							// oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- Native multiline input with a shared suggestion list.
							role="combobox"
							aria-autocomplete="list"
							aria-expanded={suggestionMenuOpen}
							aria-controls={suggestionMenuOpen ? suggestionMenuId : undefined}
							aria-activedescendant={
								suggestionMenuOpen &&
								effectiveHighlightedIndex >= 0 &&
								filteredSuggestions.length > 0
									? `${suggestionMenuId}-${effectiveHighlightedIndex}`
									: undefined
							}
							onChange={(event) => {
								onNextPromptDismiss?.();
								onFieldChange(event.target.value, event.target.selectionStart);
							}}
							onSelect={syncCaret}
							onClick={syncCaret}
							onKeyUp={syncCaret}
							onKeyDown={(event) => {
								if (
									event.key === "Backspace" &&
									!event.ctrlKey &&
									!event.metaKey &&
									!event.altKey &&
									!isImeComposingKeyboardEvent(event) &&
									removeLastMention(event.currentTarget)
								) {
									event.preventDefault();
									return;
								}
								if (
									!suggestionMenuOpen &&
									!isImeComposingKeyboardEvent(event)
								) {
									// Esc also invalidates a prediction that has not returned yet.
									if (event.key === "Escape") onNextPromptDismiss?.();
								}
								if (
									ghostText &&
									!suggestionMenuOpen &&
									!isImeComposingKeyboardEvent(event)
								) {
									if (
										event.key === "Tab" &&
										!event.shiftKey &&
										!event.ctrlKey &&
										!event.metaKey &&
										!event.altKey
									) {
										event.preventDefault();
										adoptNextPrompt();
										return;
									}
									if (event.key === "Escape") {
										event.preventDefault();
										return;
									}
								}
								handleKeyDown(event);
							}}
							onPaste={(event) => {
								onNextPromptDismiss?.();
								handlePaste(event);
							}}
							disabled={disabled || sendingNow}
							style={
								{
									"--pilo-reading-font-size": `${readingFontSize}px`,
									fontFamily: `var(--pilo-mobile-font-family, ${getPageFontFamilyStack(readingFontFamily)})`,
								} as CSSProperties
							}
							aria-label={composerPlaceholder}
							placeholder={ghostText || composerPlaceholder}
							className={cn(
								CHAT_COMPOSER_TEXTAREA_CLASS_NAME,
								"w-full min-h-0 min-w-0 pointer-coarse:min-h-11",
								ghostText ? "pr-20" : showFocusHint && "pr-16",
							)}
						/>

						<div className="pointer-events-none absolute end-0 top-0 z-10 flex h-(--pilo-composer-line-height) items-center">
							{ghostText ? (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={adoptNextPrompt}
									className="pointer-events-auto h-7 px-2 text-xs text-muted-foreground pointer-coarse:min-h-11"
									aria-label={t("chat.adoptNextPrompt", { text: ghostText })}
									aria-keyshortcuts="Tab"
								>
									<span className="flex items-center gap-1.5 pointer-coarse:hidden">
										<span aria-hidden="true">→</span>
										<kbd className="rounded border border-border/70 bg-muted/50 px-1 py-px font-mono text-2xs">
											Tab
										</kbd>
									</span>
									<span className="hidden pointer-coarse:inline">
										{t("chat.acceptNextPrompt")}
									</span>
								</Button>
							) : null}

							{showFocusHint && !ghostText ? (
								<div
									className="flex items-center gap-0.5 font-mono text-2xs text-muted-foreground opacity-70 transition-opacity group-focus-within:opacity-0"
									aria-hidden="true"
								>
									{formatKeyboardShortcut(
										keyboardShortcuts["focus-composer"],
									).map((label, index) => (
										<span key={label} className="flex items-center gap-0.5">
											{index > 0 ? <span>+</span> : null}
											<kbd className="rounded border border-border/70 bg-muted/50 px-1 py-px">
												{label}
											</kbd>
										</span>
									))}
								</div>
							) : null}
						</div>
					</div>
				</div>

				<div
					data-chat-composer-toolbar=""
					className={CHAT_COMPOSER_TOOLBAR_CLASS_NAME}
				>
					<output className="sr-only" aria-live="polite">
						{processing ? t("chat.preparingAttachments") : ""}
					</output>
					<input
						ref={fileInputRef}
						type="file"
						disabled={disabled || sendingNow || processing}
						multiple
						className="hidden"
						onChange={handleFiles}
					/>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								disabled={disabled || sendingNow || processing}
								variant="ghost"
								size="icon"
								className={CHAT_COMPOSER_ATTACHMENT_BUTTON_CLASS_NAME}
								data-chat-composer-attachment=""
								aria-label={
									processing
										? t("chat.preparingAttachments")
										: t("chat.addAttachment")
								}
								aria-busy={processing}
								onClick={() => {
									onNextPromptDismiss?.();
									editorRef.current?.blur();
									fileInputRef.current?.click();
								}}
							>
								{processing ? (
									<LoaderCircle
										className="size-4 animate-spin motion-reduce:animate-none"
										aria-hidden="true"
									/>
								) : (
									<Plus className="size-4" />
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							{processing
								? t("chat.preparingAttachments")
								: t("chat.addAttachment")}
						</TooltipContent>
					</Tooltip>

					<ComposerRunConfig
						models={models}
						modelScope={modelScope}
						canEditScope={canEditScope}
						selectedModel={selectedModel}
						modelLoading={modelLoading}
						modelError={modelError}
						modelDisabled={modelDisabled}
						onModelMenuOpen={onModelMenuOpen}
						onModelRefresh={onModelRefresh}
						onModelChange={
							onModelChange
								? (model) => {
										onNextPromptDismiss?.();
										onModelChange(model);
									}
								: undefined
						}
						thinkingLevels={thinkingLevels}
						selectedThinkingLevel={selectedThinkingLevel}
						thinkingLoading={thinkingLoading}
						thinkingDisabled={thinkingDisabled}
						onThinkingMenuOpen={onThinkingMenuOpen}
						onThinkingChange={onThinkingChange}
					/>

					<ComposerContextUsage
						usage={contextUsage}
						contextWindow={selectedModel?.contextWindow}
					/>
					{pendingFollowUps > 0 ? (
						<span className="hidden text-2xs tabular-nums text-muted-foreground @min-[40rem]:inline">
							{t("chat.pendingFollowUp", { count: pendingFollowUps })}
						</span>
					) : null}

					<ComposerActions
						leadingActions={
							// 草稿优化作用于输入内容，和发送方式、发送按钮同组贴右。
							onEnhancePrompt ? (
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											disabled={enhanceDisabled}
											className={CHAT_COMPOSER_ATTACHMENT_BUTTON_CLASS_NAME}
											data-chat-composer-enhance=""
											aria-label={
												enhancing
													? t("chat.enhancingPrompt")
													: t("chat.enhancePrompt")
											}
											aria-busy={enhancing}
											onClick={() => {
												onNextPromptDismiss?.();
												void handleEnhancePrompt();
											}}
										>
											{enhancing ? (
												<Spinner className="size-3.5" />
											) : (
												<PencilSparkles className="size-4" />
											)}
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										{enhancing
											? t("chat.enhancingPrompt")
											: t("chat.enhancePrompt")}
									</TooltipContent>
								</Tooltip>
							) : null
						}
						value={value}
						hasAttachments={attachments.length > 0}
						disabled={disabled || sendingNow}
						running={running}
						sendMessageShortcut={sendMessageShortcut}
						showShortcutHint={desktopShortcuts}
						onStop={onStop}
						canSteer={Boolean(onSteer)}
						canFollowUp={Boolean(onFollowUp)}
						canSendNow={Boolean(onSendNow)}
						canSubmit={canSubmit}
						sendMode={sendMode}
						onSendModeChange={setSendMode}
						submitBlocked={compacting || sendingNow || processing}
						onPrimary={() => {
							onNextPromptDismiss?.();
							submit();
						}}
					/>
				</div>
			</ChatComposerSurface>
		</ChatComposerRoot>
	);
}
