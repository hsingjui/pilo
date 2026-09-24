import {
	useLayoutEffect,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ChangeEvent,
	type ClipboardEvent,
	type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";

import { i18n } from "@/i18n";
import { userErrorMessage } from "@/lib/app-error";
import { ChatImageThumbnail } from "@/components/chat/chat-image-viewer";

import { cacheLocalChatImages } from "@/lib/chat-image-media";
import {
	appendChatInputHistory,
	isChatInputHistoryCursorValid,
	moveChatInputHistory,
	readChatInputHistory,
} from "@/lib/chat-input-history";
import { isImeComposingKeyboardEvent } from "@/lib/ime";
import { formatKeyboardShortcut } from "@/lib/keyboard-shortcuts";
import { useKeyboardShortcut } from "@/lib/use-keyboard-shortcut";
import type { PiModel, PiThinkingLevel } from "@/lib/pi-runtime";
import { cn } from "@/lib/utils";
import { usePreferences } from "@/lib/preferences-provider";
import {
	CHAT_IMAGE_ACCEPT,
	MAX_CHAT_IMAGE_BYTES,
	MAX_CHAT_IMAGE_COUNT,
	MAX_CHAT_IMAGE_TOTAL_BYTES,
	chatSubmissionHasContent,
	createChatSubmission,
	formatChatImageSize,
	resolveChatImageMimeType,
	type ChatImageAttachment,
	type ChatSubmission,
} from "@/lib/chat-submission";
import {
	Button,
	Textarea,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
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
import {
	ComposerSuggestionMenu,
	DEFAULT_SUGGESTIONS,
	FILE_SUGGESTION_LIMIT,
	TRIGGER_META,
	activeSuggestionQuery,
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
	onSubmit?: (submission: ChatSubmission) => void;
	onSteer?: (submission: ChatSubmission) => void;
	onFollowUp?: (submission: ChatSubmission) => void;
	placeholder?: string;
	disabled?: boolean;
	muted?: boolean;
	running?: boolean;
	onStop?: () => void;
	pendingFollowUps?: number;
	statusText?: string;
	compacting?: boolean;
	retrying?: boolean;
	onAbortRetry?: () => void;
	contextUsage?: ChatSessionRuntimeState | null;
	models?: readonly PiModel[];
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
};

const MAX_ROWS = 12;
const LINE_HEIGHT = 24;
const EMPTY_MODELS: readonly PiModel[] = [];
const EMPTY_THINKING_LEVELS: readonly PiThinkingLevel[] = [];

function readImage(file: File, mimeType: string) {
	return new Promise<ChatImageAttachment>((resolve, reject) => {
		const reader = new FileReader();
		reader.addEventListener("error", () => {
			reject(reader.error ?? new Error(i18n.t("chat.readImageFailed")));
		});
		reader.addEventListener("load", () => {
			const result = reader.result;
			if (typeof result !== "string") {
				reject(new Error(i18n.t("chat.readImageFailed")));
				return;
			}
			const separator = result.indexOf(",");
			if (separator < 0) {
				reject(new Error(i18n.t("chat.invalidImage")));
				return;
			}
			resolve({
				id: crypto.randomUUID(),
				name:
					file.name ||
					`${i18n.t("chat.imageClipboard")}.${mimeType.split("/")[1] ?? "png"}`,
				mimeType,
				size: file.size,
				data: result.slice(separator + 1),
			});
		});
		reader.readAsDataURL(file);
	});
}

export function ChatComposer({
	value,
	onChange,
	images,
	onImagesChange,
	onSubmit,
	onSteer,
	onFollowUp,
	placeholder,
	disabled = false,
	muted = false,
	running = false,
	onStop,
	pendingFollowUps = 0,
	statusText = "",
	compacting = false,
	retrying = false,
	onAbortRetry,
	contextUsage = null,
	models = EMPTY_MODELS,
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
}: ChatComposerProps) {
	const { t } = useTranslation();
	const composerPlaceholder = placeholder ?? t("chat.composerPlaceholder");
	const { sendMessageShortcut, keyboardShortcuts } = usePreferences();
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [localImages, setLocalImages] = useState<ChatImageAttachment[]>([]);
	const attachments = images ?? localImages;
	const [caret, setCaret] = useState(value.length);
	const [highlightedIndex, setHighlightedIndex] = useState(0);
	const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
	const historyEntriesRef = useRef<string[]>([]);
	const historyCursorRef = useRef<number | null>(null);

	const resetHistoryNavigation = () => {
		historyEntriesRef.current = [];
		historyCursorRef.current = null;
	};

	useEffect(() => {
		historyEntriesRef.current = historyKey
			? readChatInputHistory(historyKey)
			: [];
		historyCursorRef.current = null;
	}, [historyKey]);

	useKeyboardShortcut(
		keyboardShortcuts["focus-composer"],
		() => textareaRef.current?.focus(),
		{ enabled: !disabled },
	);

	// 挂载或从后台切回该会话（新开会话、点击通知打开会话、侧边栏切换）时
	// 聚焦输入框；disabled 变化也涵盖恢复重连/外部运行结束后的场景。
	const prevDisabledRef = useRef(true);
	useEffect(() => {
		if (prevDisabledRef.current && !disabled) textareaRef.current?.focus();
		prevDisabledRef.current = disabled;
	}, [disabled]);

	// 窗口重新获得焦点（如点击系统通知回到应用）时，若应用内没有其他焦点
	// 元素（终端、重命名输入框等），把焦点放回输入框。
	useEffect(() => {
		if (disabled) return;
		const handleWindowFocus = () => {
			const activeElement = document.activeElement;
			if (activeElement && activeElement !== document.body) return;
			textareaRef.current?.focus();
		};
		window.addEventListener("focus", handleWindowFocus);
		return () => window.removeEventListener("focus", handleWindowFocus);
	}, [disabled]);

	const showFocusHint =
		!disabled && value.length === 0 && attachments.length === 0;

	useLayoutEffect(() => {
		const textarea = textareaRef.current;
		if (!textarea) return;
		textarea.style.height = "auto";
		const maxHeight = MAX_ROWS * LINE_HEIGHT + 16;
		const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
		textarea.style.height = `${Math.max(48, nextHeight)}px`;
		textarea.style.overflowY =
			textarea.scrollHeight > maxHeight ? "auto" : "hidden";
	});

	const activeQuery = useMemo(
		() => activeSuggestionQuery(value, Math.min(caret, value.length)),
		[value, caret],
	);
	const activeTrigger = activeQuery?.trigger ?? null;
	const activeSuggestionText = activeQuery?.query ?? "";
	useEffect(() => {
		onSuggestionTrigger?.(activeTrigger, activeSuggestionText);
	}, [activeSuggestionText, activeTrigger, onSuggestionTrigger]);
	const activeKey = activeQuery
		? `${activeQuery.start}:${activeQuery.trigger}:${activeQuery.query}`
		: null;
	const queryMeta = activeQuery ? TRIGGER_META[activeQuery.trigger] : null;
	const filteredSuggestions = useMemo(() => {
		if (!activeQuery || !queryMeta) return [];
		const query = activeQuery.query.toLowerCase();
		const limit = activeQuery.trigger === "@" ? FILE_SUGGESTION_LIMIT : 9;
		return suggestions
			.filter((suggestion) => suggestion.kind === queryMeta.kind)
			.filter((suggestion) => {
				if (!query) return true;
				return [suggestion.label, suggestion.value, suggestion.detail]
					.filter(Boolean)
					.some((part) => part!.toLowerCase().includes(query));
			})
			.slice(0, limit);
	}, [activeQuery, queryMeta, suggestions]);
	const suggestionMenuOpen = Boolean(
		activeQuery &&
		activeKey !== dismissedQuery &&
		(activeQuery.trigger !== "@" || filteredSuggestions.length > 0),
	);
	const effectiveHighlightedIndex =
		filteredSuggestions.length > 0
			? Math.min(highlightedIndex, filteredSuggestions.length - 1)
			: 0;

	const updateImages = (next: ChatImageAttachment[]) => {
		cacheLocalChatImages(next);
		if (onImagesChange) onImagesChange(next);
		else setLocalImages(next);
	};

	const createSubmission = () => createChatSubmission(value, attachments);

	const rememberSubmission = (submission: ChatSubmission) => {
		if (submission.text) appendChatInputHistory(historyKey, submission.text);
		resetHistoryNavigation();
	};

	const canSendImages = () => {
		if (attachments.length === 0) return true;
		if (!selectedModel?.input || selectedModel.input.includes("image"))
			return true;
		toast.error(t("chat.imageUnsupported"));
		return false;
	};

	const submit = () => {
		const submission = createSubmission();
		if (
			!chatSubmissionHasContent(submission) ||
			disabled ||
			compacting ||
			!canSendImages()
		)
			return;
		if (running) {
			if (!onSteer) return;
			rememberSubmission(submission);
			onSteer(submission);
			return;
		}
		if (!onSubmit) return;
		rememberSubmission(submission);
		onSubmit(submission);
	};

	const submitFollowUp = () => {
		const submission = createSubmission();
		if (
			!chatSubmissionHasContent(submission) ||
			disabled ||
			compacting ||
			!running ||
			!onFollowUp ||
			!canSendImages()
		)
			return;
		rememberSubmission(submission);
		onFollowUp(submission);
	};

	const applyHistoryValue = (nextValue: string) => {
		onChange(nextValue);
		setCaret(nextValue.length);
		setHighlightedIndex(0);
		setDismissedQuery(null);
		requestAnimationFrame(() => {
			const textarea = textareaRef.current;
			if (!textarea) return;
			textarea.focus();
			textarea.setSelectionRange(nextValue.length, nextValue.length);
		});
	};

	const handleHistoryNavigation = (
		event: KeyboardEvent<HTMLTextAreaElement>,
	) => {
		if (
			(event.key !== "ArrowUp" && event.key !== "ArrowDown") ||
			event.shiftKey ||
			event.ctrlKey ||
			event.metaKey ||
			event.altKey ||
			isImeComposingKeyboardEvent(event) ||
			!historyKey
		) {
			return false;
		}

		const browsingHistory = historyCursorRef.current !== null;
		if (
			browsingHistory &&
			!isChatInputHistoryCursorValid(
				historyEntriesRef.current,
				historyCursorRef.current,
				value,
			)
		) {
			resetHistoryNavigation();
			return false;
		}
		if (!browsingHistory && value.length > 0) return false;

		if (!browsingHistory) {
			if (event.key === "ArrowDown") return false;
			historyEntriesRef.current = readChatInputHistory(historyKey);
		}

		const result = moveChatInputHistory(
			historyEntriesRef.current,
			historyCursorRef.current,
			event.key === "ArrowUp" ? "older" : "newer",
		);
		if (!result.handled) return false;

		event.preventDefault();
		historyCursorRef.current = result.cursor;
		applyHistoryValue(result.value);
		return true;
	};

	const selectSuggestion = (suggestion: ComposerSuggestion) => {
		if (!activeQuery) return;
		const inserted = `${suggestion.value} `;
		const nextValue = `${value.slice(0, activeQuery.start)}${inserted}${value.slice(activeQuery.end)}`;
		const nextCaret = activeQuery.start + inserted.length;
		resetHistoryNavigation();
		onChange(nextValue);
		setCaret(nextCaret);
		setDismissedQuery(
			`${activeQuery.start}:${activeQuery.trigger}:__selected__`,
		);
		requestAnimationFrame(() => {
			const textarea = textareaRef.current;
			if (!textarea) return;
			textarea.focus();
			textarea.setSelectionRange(nextCaret, nextCaret);
		});
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		const primaryShortcutModifierMatches =
			sendMessageShortcut === "enter"
				? !event.ctrlKey && !event.metaKey
				: event.ctrlKey || event.metaKey;
		const shouldFollowUpWithEnter =
			running &&
			event.key === "Enter" &&
			event.altKey &&
			!event.shiftKey &&
			!isImeComposingKeyboardEvent(event) &&
			primaryShortcutModifierMatches;

		if (shouldFollowUpWithEnter) {
			event.preventDefault();
			submitFollowUp();
			return;
		}

		if (
			historyCursorRef.current !== null &&
			(event.key === "ArrowUp" || event.key === "ArrowDown") &&
			handleHistoryNavigation(event)
		) {
			return;
		}

		if (suggestionMenuOpen && !isImeComposingKeyboardEvent(event)) {
			if (
				event.key === "Tab" &&
				!event.shiftKey &&
				!event.ctrlKey &&
				!event.metaKey &&
				!event.altKey &&
				filteredSuggestions[effectiveHighlightedIndex]
			) {
				event.preventDefault();
				selectSuggestion(filteredSuggestions[effectiveHighlightedIndex]);
				return;
			}
			if (event.key === "ArrowDown" && filteredSuggestions.length > 0) {
				event.preventDefault();
				setHighlightedIndex(
					(index) => (index + 1) % filteredSuggestions.length,
				);
				return;
			}
			if (event.key === "ArrowUp" && filteredSuggestions.length > 0) {
				event.preventDefault();
				setHighlightedIndex(
					(index) =>
						(index - 1 + filteredSuggestions.length) %
						filteredSuggestions.length,
				);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				setDismissedQuery(activeKey);
				return;
			}
			if (
				event.key === "Enter" &&
				filteredSuggestions[effectiveHighlightedIndex]
			) {
				event.preventDefault();
				selectSuggestion(filteredSuggestions[effectiveHighlightedIndex]);
				return;
			}
		}

		if (handleHistoryNavigation(event)) return;

		const shouldSubmitWithEnter =
			event.key === "Enter" &&
			!event.shiftKey &&
			!event.altKey &&
			!isImeComposingKeyboardEvent(event) &&
			primaryShortcutModifierMatches;

		if (shouldSubmitWithEnter) {
			event.preventDefault();
			submit();
		}
	};

	const addImageFiles = async (files: readonly File[]) => {
		if (files.length === 0) return;
		const availableSlots = Math.max(
			0,
			MAX_CHAT_IMAGE_COUNT - attachments.length,
		);
		if (availableSlots === 0) {
			toast.error(t("chat.maxImages", { count: MAX_CHAT_IMAGE_COUNT }));
			return;
		}
		const accepted: Array<{ file: File; mimeType: string }> = [];
		let totalBytes = attachments.reduce(
			(total, image) => total + image.size,
			0,
		);
		for (const file of files) {
			if (accepted.length >= availableSlots) break;
			const mimeType = resolveChatImageMimeType(file);
			if (!mimeType) {
				toast.error(
					t("chat.unsupportedImage", {
						name: file.name || t("chat.imageClipboard"),
					}),
				);
				continue;
			}
			if (file.size > MAX_CHAT_IMAGE_BYTES) {
				toast.error(
					t("chat.imageTooLarge", {
						name: file.name || t("chat.imageClipboard"),
					}),
					{
						description: t("chat.imageSizeLimit", {
							size: formatChatImageSize(MAX_CHAT_IMAGE_BYTES),
						}),
					},
				);
				continue;
			}
			if (totalBytes + file.size > MAX_CHAT_IMAGE_TOTAL_BYTES) {
				toast.error(t("chat.imagesTooLarge"), {
					description: t("chat.imagesTotalLimit", {
						size: formatChatImageSize(MAX_CHAT_IMAGE_TOTAL_BYTES),
					}),
				});
				break;
			}
			accepted.push({ file, mimeType });
			totalBytes += file.size;
		}
		if (files.length > availableSlots) {
			toast.info(t("chat.maxImages", { count: MAX_CHAT_IMAGE_COUNT }));
		}
		if (accepted.length === 0) return;
		try {
			const added = await Promise.all(
				accepted.map(({ file, mimeType }) => readImage(file, mimeType)),
			);
			updateImages([...attachments, ...added]);
		} catch (error) {
			toast.error(t("chat.readImageFailed"), {
				description: userErrorMessage(error),
			});
		}
	};

	const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(event.target.files ?? []);
		void addImageFiles(files);
		event.target.value = "";
	};

	const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
		const files = Array.from(event.clipboardData.items)
			.filter((item) => item.kind === "file" && item.type.startsWith("image/"))
			.flatMap((item) => {
				const file = item.getAsFile();
				return file ? [file] : [];
			});
		if (files.length > 0) {
			event.preventDefault();
			void addImageFiles(files);
		}
	};

	const syncCaret = () => {
		const textarea = textareaRef.current;
		if (!textarea) return;
		setCaret(textarea.selectionStart ?? value.length);
	};

	return (
		<ChatComposerRoot className={className}>
			{suggestionMenuOpen && activeQuery && queryMeta ? (
				<ComposerSuggestionMenu
					activeQuery={activeQuery}
					title={t(queryMeta.titleKey)}
					suggestions={filteredSuggestions}
					highlightedIndex={effectiveHighlightedIndex}
					onHighlight={setHighlightedIndex}
					onSelect={selectSuggestion}
				/>
			) : null}

			<ChatComposerSurface muted={muted}>
				{attachments.length > 0 ? (
					<div className="flex flex-wrap gap-1.5 px-1 pb-1">
						{attachments.map((attachment) => (
							<div key={attachment.id} className="relative">
								<ChatImageThumbnail
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
									disabled={disabled}
									aria-label={t("chat.removeAttachment", {
										name: attachment.name,
									})}
									className={cn(
										"absolute -right-1.5 -top-1.5 z-10 inline-flex size-5 items-center justify-center rounded-full",
										"border border-border/70 bg-background text-muted-foreground shadow-sm transition-colors",
										"hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
										disabled && "opacity-60",
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
					</div>
				) : null}

				<Textarea
					ref={textareaRef}
					value={value}
					onChange={(event) => {
						resetHistoryNavigation();
						onChange(event.target.value);
						setCaret(event.target.selectionStart ?? event.target.value.length);
						setHighlightedIndex(0);
						setDismissedQuery(null);
					}}
					onSelect={syncCaret}
					onClick={syncCaret}
					onKeyUp={syncCaret}
					onKeyDown={handleKeyDown}
					onPaste={handlePaste}
					disabled={disabled}
					rows={2}
					placeholder={composerPlaceholder}
					className={cn(
						CHAT_COMPOSER_TEXTAREA_CLASS_NAME,
						showFocusHint && "pr-16",
					)}
				/>

				{showFocusHint ? (
					<div
						className="pointer-events-none absolute right-2 top-1.5 z-10 flex items-center gap-0.5 font-mono text-2xs text-muted-foreground opacity-70 transition-opacity group-focus-within:opacity-0"
						aria-hidden="true"
					>
						{formatKeyboardShortcut(keyboardShortcuts["focus-composer"]).map(
							(label, index) => (
								<span key={label} className="flex items-center gap-0.5">
									{index > 0 ? <span>+</span> : null}
									<kbd className="rounded border border-border/70 bg-muted/50 px-1 py-px">
										{label}
									</kbd>
								</span>
							),
						)}
					</div>
				) : null}

				<div className={CHAT_COMPOSER_TOOLBAR_CLASS_NAME}>
					<input
						ref={fileInputRef}
						type="file"
						disabled={disabled}
						accept={CHAT_IMAGE_ACCEPT}
						multiple
						className="hidden"
						onChange={handleFiles}
					/>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								disabled={disabled}
								variant="ghost"
								size="icon"
								className={CHAT_COMPOSER_ATTACHMENT_BUTTON_CLASS_NAME}
								aria-label={t("chat.addAttachment")}
								onClick={() => fileInputRef.current?.click()}
							>
								<Plus className="size-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("chat.addAttachment")}</TooltipContent>
					</Tooltip>

					<ComposerRunConfig
						models={models}
						selectedModel={selectedModel}
						modelLoading={modelLoading}
						modelError={modelError}
						modelDisabled={modelDisabled}
						onModelMenuOpen={onModelMenuOpen}
						onModelRefresh={onModelRefresh}
						onModelChange={onModelChange}
						thinkingLevels={thinkingLevels}
						selectedThinkingLevel={selectedThinkingLevel}
						thinkingLoading={thinkingLoading}
						thinkingDisabled={thinkingDisabled}
						onThinkingMenuOpen={onThinkingMenuOpen}
						onThinkingChange={onThinkingChange}
					/>

					{pendingFollowUps > 0 ? (
						<span className="hidden text-2xs tabular-nums text-muted-foreground @min-[40rem]:inline">
							{t("chat.pendingFollowUp", { count: pendingFollowUps })}
						</span>
					) : null}
					{statusText ? (
						<span className="hidden truncate text-2xs tabular-nums text-muted-foreground @min-[48rem]:inline">
							{statusText}
						</span>
					) : null}
					{retrying && onAbortRetry ? (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="h-7 px-2 text-2xs text-muted-foreground"
							onClick={onAbortRetry}
						>
							停止重试
						</Button>
					) : null}

					<ComposerContextUsage
						usage={contextUsage}
						contextWindow={selectedModel?.contextWindow}
					/>

					<ComposerActions
						value={value}
						hasAttachments={attachments.length > 0}
						disabled={disabled}
						running={running}
						sendMessageShortcut={sendMessageShortcut}
						onStop={onStop}
						canSteer={Boolean(onSteer)}
						submitBlocked={compacting}
						onPrimary={submit}
					/>
				</div>
			</ChatComposerSurface>
		</ChatComposerRoot>
	);
}
