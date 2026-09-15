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
import { Image as ImageIcon, Plus, X } from "lucide-react";
import { toast } from "sonner";

import { userErrorMessage } from "@/lib/app-error";
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
	DEFAULT_CHAT_COMPOSER_PLACEHOLDER,
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
	pendingSteering?: number;
	pendingFollowUps?: number;
	statusText?: string;
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
			reject(reader.error ?? new Error("读取图片失败"));
		});
		reader.addEventListener("load", () => {
			const result = reader.result;
			if (typeof result !== "string") {
				reject(new Error("读取图片失败"));
				return;
			}
			const separator = result.indexOf(",");
			if (separator < 0) {
				reject(new Error("图片数据格式无效"));
				return;
			}
			resolve({
				id: crypto.randomUUID(),
				name: file.name || `粘贴的图片.${mimeType.split("/")[1] ?? "png"}`,
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
	placeholder = DEFAULT_CHAT_COMPOSER_PLACEHOLDER,
	disabled = false,
	muted = false,
	running = false,
	onStop,
	pendingSteering = 0,
	pendingFollowUps = 0,
	statusText = "",
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
	className,
}: ChatComposerProps) {
	const { sendMessageShortcut, keyboardShortcuts } = usePreferences();
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [localImages, setLocalImages] = useState<ChatImageAttachment[]>([]);
	const attachments = images ?? localImages;
	const [caret, setCaret] = useState(value.length);
	const [highlightedIndex, setHighlightedIndex] = useState(0);
	const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);

	useKeyboardShortcut(
		keyboardShortcuts["focus-composer"],
		() => textareaRef.current?.focus(),
		{ enabled: !disabled },
	);

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
		if (onImagesChange) onImagesChange(next);
		else setLocalImages(next);
	};

	const createSubmission = () => createChatSubmission(value, attachments);

	const canSendImages = () => {
		if (attachments.length === 0) return true;
		if (!selectedModel?.input || selectedModel.input.includes("image"))
			return true;
		toast.error("当前模型不支持图片输入");
		return false;
	};

	const submit = () => {
		const submission = createSubmission();
		if (!chatSubmissionHasContent(submission) || disabled || !canSendImages())
			return;
		if (running) {
			onSteer?.(submission);
			return;
		}
		onSubmit?.(submission);
	};

	const submitFollowUp = () => {
		const submission = createSubmission();
		if (
			!chatSubmissionHasContent(submission) ||
			disabled ||
			!running ||
			!canSendImages()
		)
			return;
		onFollowUp?.(submission);
	};

	const selectSuggestion = (suggestion: ComposerSuggestion) => {
		if (!activeQuery) return;
		const inserted = `${suggestion.value} `;
		const nextValue = `${value.slice(0, activeQuery.start)}${inserted}${value.slice(activeQuery.end)}`;
		const nextCaret = activeQuery.start + inserted.length;
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
			toast.error(`最多添加 ${MAX_CHAT_IMAGE_COUNT} 张图片`);
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
				toast.error(`不支持的图片格式：${file.name || "剪贴板图片"}`);
				continue;
			}
			if (file.size > MAX_CHAT_IMAGE_BYTES) {
				toast.error(`图片过大：${file.name || "剪贴板图片"}`, {
					description: `单张图片不能超过 ${formatChatImageSize(MAX_CHAT_IMAGE_BYTES)}`,
				});
				continue;
			}
			if (totalBytes + file.size > MAX_CHAT_IMAGE_TOTAL_BYTES) {
				toast.error("图片总大小过大", {
					description: `单条消息的图片总大小不能超过 ${formatChatImageSize(MAX_CHAT_IMAGE_TOTAL_BYTES)}`,
				});
				break;
			}
			accepted.push({ file, mimeType });
			totalBytes += file.size;
		}
		if (files.length > availableSlots) {
			toast.info(`最多添加 ${MAX_CHAT_IMAGE_COUNT} 张图片`);
		}
		if (accepted.length === 0) return;
		try {
			const added = await Promise.all(
				accepted.map(({ file, mimeType }) => readImage(file, mimeType)),
			);
			updateImages([...attachments, ...added]);
		} catch (error) {
			toast.error("无法读取图片", { description: userErrorMessage(error) });
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
					title={queryMeta.title}
					hint={queryMeta.hint}
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
							<div
								key={attachment.id}
								className="flex max-w-56 items-center gap-1.5 rounded-lg border border-border/70 bg-muted/45 px-2 py-1.5 text-xs"
							>
								<ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
								<span className="min-w-0 truncate">{attachment.name}</span>
								<span className="shrink-0 text-[11px] text-muted-foreground">
									{formatChatImageSize(attachment.size)}
								</span>
								<button
									type="button"
									disabled={disabled}
									aria-label={`移除 ${attachment.name}`}
									className="ml-1 rounded-sm text-muted-foreground hover:text-foreground"
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
					placeholder={placeholder}
					className={cn(
						CHAT_COMPOSER_TEXTAREA_CLASS_NAME,
						showFocusHint && "pr-16",
					)}
				/>

				{showFocusHint ? (
					<div
						className="pointer-events-none absolute right-2 top-1.5 z-10 flex items-center gap-0.5 font-mono text-[11px] text-muted-foreground opacity-70 transition-opacity group-focus-within:opacity-0"
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
								aria-label="添加附件"
								onClick={() => fileInputRef.current?.click()}
							>
								<Plus className="size-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>添加附件</TooltipContent>
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

					{pendingSteering > 0 || pendingFollowUps > 0 ? (
						<span className="hidden text-[11px] tabular-nums text-muted-foreground sm:inline">
							{pendingSteering > 0 ? `调整 ${pendingSteering}` : null}
							{pendingSteering > 0 && pendingFollowUps > 0 ? " · " : null}
							{pendingFollowUps > 0 ? `稍后 ${pendingFollowUps}` : null}
						</span>
					) : null}
					{statusText ? (
						<span className="hidden truncate text-[11px] tabular-nums text-muted-foreground md:inline">
							{statusText}
						</span>
					) : null}
					{retrying && onAbortRetry ? (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="h-7 px-2 text-[11px] text-muted-foreground"
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
						onPrimary={submit}
					/>
				</div>
			</ChatComposerSurface>
		</ChatComposerRoot>
	);
}
