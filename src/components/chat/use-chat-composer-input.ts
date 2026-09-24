import {
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
	appendChatInputHistory,
	isChatInputHistoryCursorValid,
	moveChatInputHistory,
	readChatInputHistory,
} from "@/lib/chat-input-history";
import {
	chatSubmissionHasContent,
	createChatSubmission,
	type ChatImageAttachment,
	type ChatSubmission,
} from "@/lib/chat-submission";
import { isImeComposingKeyboardEvent } from "@/lib/ime";
import type { PiModel } from "@/lib/pi-runtime";
import { usePreferences } from "@/lib/preferences-provider";
import { useKeyboardShortcut } from "@/lib/use-keyboard-shortcut";
import {
	DEFAULT_SUGGESTIONS,
	FILE_SUGGESTION_LIMIT,
	TRIGGER_META,
	activeSuggestionQuery,
	type ComposerSuggestion,
} from "@/components/chat/chat-composer-suggestions";

const MAX_ROWS = 12;
const LINE_HEIGHT = 24;

export type ChatComposerInputOptions = {
	value: string;
	onChange: (value: string) => void;
	attachments: readonly ChatImageAttachment[];
	selectedModel?: PiModel | null;
	disabled?: boolean;
	compacting?: boolean;
	running?: boolean;
	onSubmit?: (submission: ChatSubmission) => void;
	onSteer?: (submission: ChatSubmission) => void;
	onFollowUp?: (submission: ChatSubmission) => void;
	suggestions?: readonly ComposerSuggestion[];
	onSuggestionTrigger?: (trigger: "@" | "/" | null, query: string) => void;
	historyKey?: string | null;
};

export function useChatComposerInput({
	value,
	onChange,
	attachments,
	selectedModel = null,
	disabled = false,
	compacting = false,
	running = false,
	onSubmit,
	onSteer,
	onFollowUp,
	suggestions = DEFAULT_SUGGESTIONS,
	onSuggestionTrigger,
	historyKey,
}: ChatComposerInputOptions) {
	const { t } = useTranslation();
	const { sendMessageShortcut, keyboardShortcuts } = usePreferences();
	const textareaRef = useRef<HTMLTextAreaElement>(null);
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

	const showFocusHint =
		!disabled && value.length === 0 && attachments.length === 0;

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

	const syncCaret = () => {
		const textarea = textareaRef.current;
		if (!textarea) return;
		setCaret(textarea.selectionStart ?? value.length);
	};

	return {
		textareaRef,
		showFocusHint,
		suggestionMenuOpen,
		activeQuery,
		queryMeta,
		filteredSuggestions,
		effectiveHighlightedIndex,
		setHighlightedIndex,
		selectSuggestion,
		handleKeyDown,
		syncCaret,
		submit,
		onFieldChange: (nextValue: string, nextCaret: number) => {
			resetHistoryNavigation();
			onChange(nextValue);
			setCaret(nextCaret);
			setHighlightedIndex(0);
			setDismissedQuery(null);
		},
	};
}
