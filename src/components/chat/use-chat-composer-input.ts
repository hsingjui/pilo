import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useId,
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
} from "@/lib/chat/chat-input-history";
import {
	readComposerSendMode,
	writeComposerSendMode,
	type ComposerSendMode,
} from "@/lib/chat/composer-send-mode";
import {
	chatSubmissionHasContent,
	createChatSubmission,
	type ChatImageAttachment,
	type ChatSubmission,
} from "@/lib/chat/chat-submission";
import { fileMentionPath } from "@/lib/chat/chat-mentions";
import { retainChatFiles } from "@/lib/chat/chat-file-lifecycle";
import { isImeComposingKeyboardEvent } from "@/lib/ime";
import { type PiModel, runtimeErrorMessage } from "@/lib/api/pi-runtime";
import { usePreferences } from "@/lib/preferences-provider";
import { useKeyboardShortcut } from "@/lib/use-keyboard-shortcut";
import { keyboardEventMatchesShortcut } from "@/lib/keyboard-shortcuts";
import { useIsTouchDevice } from "@/components/chat/chat-composer-run-config";
import {
	DEFAULT_SUGGESTIONS,
	FILE_SUGGESTION_LIMIT,
	TRIGGER_META,
	activeSuggestionQuery,
	type ComposerSuggestion,
	type MentionTab,
} from "@/components/chat/chat-composer-suggestions";

const MAX_ROWS = 12;
const SESSION_QUERY_META = {
	kind: "session",
	titleKey: "chat.sessionSuggestion",
} as const;

export type ChatComposerInputOptions = {
	value: string;
	submissionText?: string;
	onHistoryValue?: (value: string) => void;
	onMentionSelect?: (suggestion: ComposerSuggestion, text: string) => void;
	onChange: (value: string) => void;
	attachments: readonly ChatImageAttachment[];
	selectedModel?: PiModel | null;
	disabled?: boolean;
	submitBlocked?: boolean;
	compacting?: boolean;
	running?: boolean;
	onSubmit?: (submission: ChatSubmission) => void;
	onSteer?: (submission: ChatSubmission) => void;
	onFollowUp?: (submission: ChatSubmission) => void;
	onSendNow?: (submission: ChatSubmission) => Promise<void>;
	suggestions?: readonly ComposerSuggestion[];
	onSuggestionTrigger?: (trigger: "@" | "/" | null, query: string) => void;
	historyKey?: string | null;
	/** 桌面专属的快捷键提示与自动聚焦；Remote WebUI 传 false。 */
	desktopShortcuts?: boolean;
};

export function useChatComposerInput({
	value,
	submissionText = value,
	onHistoryValue,
	onMentionSelect,
	onChange,
	attachments,
	selectedModel = null,
	disabled = false,
	submitBlocked = false,
	compacting = false,
	running = false,
	onSubmit,
	onSteer,
	onFollowUp,
	onSendNow,
	suggestions = DEFAULT_SUGGESTIONS,
	onSuggestionTrigger,
	historyKey,
	desktopShortcuts = true,
}: ChatComposerInputOptions) {
	const { t } = useTranslation();
	const { sendMessageShortcut, keyboardShortcuts } = usePreferences();
	const isTouch = useIsTouchDevice();
	const newlineOnEnter = !desktopShortcuts && isTouch;
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const suggestionMenuId = useId();
	const [mentionNavigation, setMentionNavigation] = useState<{
		historyKey: ChatComposerInputOptions["historyKey"];
		start: number;
		tab: MentionTab;
		categoryFocused: boolean;
	} | null>(null);
	const surroundingHeightRef = useRef<number | null>(null);
	const [sendMode, setSendModeState] =
		useState<ComposerSendMode>(readComposerSendMode);
	const [sendingNow, setSendingNow] = useState(false);
	const sendingNowRef = useRef(false);
	const [caret, setCaret] = useState(value.length);
	const [highlightedIndex, setHighlightedIndex] = useState(0);
	const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
	const historyEntriesRef = useRef<string[]>([]);
	const historyCursorRef = useRef<number | null>(null);

	const resetHistoryNavigation = () => {
		historyEntriesRef.current = [];
		historyCursorRef.current = null;
	};

	// The mode is sticky: it holds until the user picks another one, so a
	// follow-up stays a follow-up across sends, sessions and reloads.
	const setSendMode = (mode: ComposerSendMode) => {
		setSendModeState(mode);
		writeComposerSendMode(mode);
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
		{ enabled: !disabled && desktopShortcuts },
	);

	// 挂载或从后台切回该会话（新开会话、点击通知打开会话、侧边栏切换）时
	// 聚焦输入框；disabled 变化也涵盖恢复重连/外部运行结束后的场景。
	const prevDisabledRef = useRef(true);
	useEffect(() => {
		if (prevDisabledRef.current && !disabled && desktopShortcuts)
			textareaRef.current?.focus();
		prevDisabledRef.current = disabled;
	}, [desktopShortcuts, disabled]);

	// 窗口重新获得焦点（如点击系统通知回到应用）时，若应用内没有其他焦点
	// 元素（终端、重命名输入框等），把焦点放回输入框。
	useEffect(() => {
		if (disabled || !desktopShortcuts) return;
		const handleWindowFocus = () => {
			const activeElement = document.activeElement;
			if (activeElement && activeElement !== document.body) return;
			textareaRef.current?.focus();
		};
		window.addEventListener("focus", handleWindowFocus);
		return () => window.removeEventListener("focus", handleWindowFocus);
	}, [desktopShortcuts, disabled]);

	const resizeTextarea = useCallback(() => {
		const textarea = textareaRef.current;
		if (!textarea) return;
		const panel = textarea.closest<HTMLElement>("[data-chat-panel]");
		const composerRegion = textarea.closest<HTMLElement>(
			"[data-chat-composer-region]",
		);
		if (panel && panel.clientHeight === 0) return;
		textarea.style.height = "auto";
		const styles = window.getComputedStyle(textarea);
		let lineHeight = Number.parseFloat(styles.lineHeight);
		const padding =
			Number.parseFloat(styles.paddingTop) +
			Number.parseFloat(styles.paddingBottom);
		const border =
			Number.parseFloat(styles.borderTopWidth) +
			Number.parseFloat(styles.borderBottomWidth);
		if (!Number.isFinite(lineHeight)) {
			// Measure native rows out of flow: shrinking the live textarea briefly
			// expands the chat viewport and clamps its scrollTop before we restore it.
			const probe = textarea.cloneNode(false) as HTMLTextAreaElement;
			probe.removeAttribute("id");
			probe.removeAttribute("name");
			probe.setAttribute("aria-hidden", "true");
			probe.tabIndex = -1;
			Object.assign(probe.style, {
				position: "absolute",
				top: "0",
				left: "0",
				width: styles.width,
				height: "auto",
				minHeight: "0",
				visibility: "hidden",
				pointerEvents: "none",
			});
			textarea.parentElement?.append(probe);
			lineHeight =
				(probe.getBoundingClientRect().height - padding - border) /
				textarea.rows;
			probe.remove();
		}
		// Keep the empty row height after typing; scrollHeight rounds fractional line heights.
		const minHeight = Math.max(
			Number.parseFloat(styles.minHeight),
			Math.ceil(textarea.rows * lineHeight + padding + border),
		);
		let maxHeight = MAX_ROWS * lineHeight + padding + border;
		if (panel && composerRegion) {
			// Reserve the toolbar, attachments, notices and bottom safe-area padding.
			const surroundingHeight =
				composerRegion.getBoundingClientRect().height -
				textarea.getBoundingClientRect().height;
			surroundingHeightRef.current = surroundingHeight;
			maxHeight = Math.max(
				minHeight,
				Math.min(maxHeight, panel.clientHeight - surroundingHeight),
			);
		}
		// Placeholder predictions must not resize an empty draft.
		const contentHeight = textarea.value
			? textarea.scrollHeight + border
			: textarea.rows * lineHeight + padding + border;
		textarea.style.height = `${Math.max(minHeight, Math.min(contentHeight, maxHeight))}px`;
		textarea.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
	}, []);

	useLayoutEffect(() => {
		resizeTextarea();
	});

	useLayoutEffect(() => {
		const textarea = textareaRef.current;
		const panel = textarea?.closest<HTMLElement>("[data-chat-panel]");
		if (!textarea || !panel) return;
		const composerRegion = textarea.closest<HTMLElement>(
			"[data-chat-composer-region]",
		);
		let frame: number | null = null;
		const observer = new ResizeObserver((entries) => {
			const panelResized = entries.some((entry) => entry.target === panel);
			const surroundingHeight = composerRegion
				? composerRegion.getBoundingClientRect().height -
					textarea.getBoundingClientRect().height
				: null;
			// Ignore region resizes caused only by changes to the textarea height.
			if (!panelResized && surroundingHeight === surroundingHeightRef.current)
				return;
			if (frame !== null) return;
			frame = requestAnimationFrame(() => {
				frame = null;
				resizeTextarea();
			});
		});
		observer.observe(panel);
		if (composerRegion) observer.observe(composerRegion);
		return () => {
			observer.disconnect();
			if (frame !== null) cancelAnimationFrame(frame);
		};
	}, [resizeTextarea]);

	const activeQuery = useMemo(
		() => activeSuggestionQuery(value, Math.min(caret, value.length)),
		[value, caret],
	);
	const activeTrigger = activeQuery?.trigger ?? null;
	const activeSuggestionText = activeQuery?.query ?? "";
	const activeKey = activeQuery
		? `${historyKey ?? ""}:${activeQuery.start}:${activeQuery.trigger}:${activeQuery.query}`
		: null;
	const mentionTab: MentionTab =
		activeQuery?.trigger === "@" &&
		mentionNavigation?.historyKey === historyKey &&
		mentionNavigation?.start === activeQuery.start
			? mentionNavigation.tab
			: "file";
	const categoryFocused =
		activeQuery?.trigger === "@" &&
		(mentionNavigation?.historyKey === historyKey &&
		mentionNavigation?.start === activeQuery.start
			? mentionNavigation.categoryFocused
			: !activeQuery.query);
	useEffect(() => {
		// Switching @ categories must not clear or restart the file query.
		onSuggestionTrigger?.(activeTrigger, activeSuggestionText);
	}, [activeSuggestionText, activeTrigger, onSuggestionTrigger]);
	const queryMeta = activeQuery
		? activeQuery.trigger === "@" && mentionTab === "session"
			? SESSION_QUERY_META
			: TRIGGER_META[activeQuery.trigger]
		: null;
	const filteredSuggestions = useMemo(() => {
		if (!activeQuery || !queryMeta) return [];
		const query = activeQuery.query.toLowerCase();
		const limit = activeQuery.trigger === "@" ? FILE_SUGGESTION_LIMIT : 9;
		return suggestions
			.filter((suggestion) => suggestion.kind === queryMeta.kind)
			.filter((suggestion) => {
				if (!query) return true;
				return [suggestion.label, suggestion.value, suggestion.detail].some(
					(part) => part?.toLowerCase().includes(query),
				);
			})
			.slice(0, limit);
	}, [activeQuery, queryMeta, suggestions]);
	const suggestionMenuOpen = Boolean(
		activeQuery && activeKey !== dismissedQuery && !disabled,
	);
	const effectiveHighlightedIndex = categoryFocused
		? -1
		: filteredSuggestions.length > 0
			? Math.min(
					mentionNavigation && mentionNavigation.historyKey !== historyKey
						? 0
						: highlightedIndex,
					filteredSuggestions.length - 1,
				)
			: 0;
	const changeMentionTab = (tab: MentionTab) => {
		if (activeQuery?.trigger !== "@") return;
		setMentionNavigation({
			historyKey,
			start: activeQuery.start,
			tab,
			categoryFocused: true,
		});
		setHighlightedIndex(0);
		textareaRef.current?.focus({ preventScroll: true });
	};
	const enterCandidates = () => {
		if (activeQuery?.trigger === "@")
			setMentionNavigation({
				historyKey,
				start: activeQuery.start,
				tab: mentionTab,
				categoryFocused: false,
			});
	};

	const showFocusHint =
		desktopShortcuts &&
		!disabled &&
		submissionText.length === 0 &&
		attachments.length === 0;

	const createSubmission = () =>
		createChatSubmission(submissionText, attachments);

	const rememberSubmission = (submission: ChatSubmission) => {
		retainChatFiles(submission.text);
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

	const runningSubmit =
		sendMode === "follow_up"
			? onFollowUp
			: sendMode === "send_now"
				? onSendNow
				: onSteer;

	const submit = () => {
		const submission = createSubmission();
		if (
			!chatSubmissionHasContent(submission) ||
			disabled ||
			submitBlocked ||
			compacting ||
			sendingNowRef.current ||
			!canSendImages()
		)
			return;
		if (running) {
			if (!runningSubmit) return;
			rememberSubmission(submission);
			if (sendMode === "send_now" && onSendNow) {
				sendingNowRef.current = true;
				setSendingNow(true);
				void onSendNow(submission)
					.catch((error) => {
						toast.error(t("chat.immediateSendFailed"), {
							description: runtimeErrorMessage(error),
						});
					})
					.finally(() => {
						sendingNowRef.current = false;
						setSendingNow(false);
					});
			} else {
				runningSubmit(submission);
			}
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
			submitBlocked ||
			compacting ||
			sendingNowRef.current ||
			!running ||
			!onFollowUp ||
			!canSendImages()
		)
			return;
		rememberSubmission(submission);
		onFollowUp(submission);
	};

	const applyHistoryValue = (nextValue: string) => {
		(onHistoryValue ?? onChange)(nextValue);
		setMentionNavigation(null);
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
				submissionText,
			)
		) {
			resetHistoryNavigation();
			return false;
		}
		if (!browsingHistory && submissionText.length > 0) return false;

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
		const isMention =
			suggestion.kind === "session" ||
			(suggestion.kind === "file" &&
				fileMentionPath(suggestion.value) !== null);
		const inserted = isMention ? "" : `${suggestion.value} `;
		const nextValue = `${value.slice(0, activeQuery.start)}${inserted}${value.slice(activeQuery.end)}`;
		const nextCaret = activeQuery.start + inserted.length;
		resetHistoryNavigation();
		setMentionNavigation(null);
		if (isMention) onMentionSelect?.(suggestion, nextValue);
		else onChange(nextValue);
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
		if (newlineOnEnter && event.key === "Enter") return;

		const primaryShortcutModifierMatches =
			sendMessageShortcut === "enter"
				? !event.ctrlKey && !event.metaKey
				: event.ctrlKey || event.metaKey;
		// 排队发送走独立快捷键（默认 Alt+Enter），只在此轮运行时才有意义；
		// 它不属于“回车发送 / 修饰键发送”偏好，因此在两种偏好下都能用。
		const shouldQueueWithShortcut =
			running &&
			!isImeComposingKeyboardEvent(event) &&
			keyboardEventMatchesShortcut(event, keyboardShortcuts["queue-message"]);

		if (shouldQueueWithShortcut) {
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
				!event.altKey
			) {
				if (categoryFocused) {
					event.preventDefault();
					changeMentionTab(mentionTab === "file" ? "session" : "file");
					return;
				}
				const suggestion = filteredSuggestions[effectiveHighlightedIndex];
				if (suggestion) {
					event.preventDefault();
					selectSuggestion(suggestion);
					return;
				}
			}
			if (event.key === "ArrowDown" && filteredSuggestions.length > 0) {
				event.preventDefault();
				enterCandidates();
				setHighlightedIndex(
					categoryFocused
						? 0
						: (effectiveHighlightedIndex + 1) % filteredSuggestions.length,
				);
				return;
			}
			if (
				event.key === "ArrowUp" &&
				activeQuery?.trigger === "@" &&
				!categoryFocused &&
				effectiveHighlightedIndex === 0
			) {
				event.preventDefault();
				changeMentionTab(mentionTab);
				return;
			}
			if (event.key === "ArrowUp" && filteredSuggestions.length > 0) {
				event.preventDefault();
				enterCandidates();
				setHighlightedIndex(
					categoryFocused
						? filteredSuggestions.length - 1
						: (effectiveHighlightedIndex - 1 + filteredSuggestions.length) %
								filteredSuggestions.length,
				);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				setDismissedQuery(activeKey);
				return;
			}
			if (event.key === "Enter") {
				const suggestion =
					filteredSuggestions[categoryFocused ? 0 : effectiveHighlightedIndex];
				if (suggestion) {
					event.preventDefault();
					selectSuggestion(suggestion);
					return;
				}
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
		sendMode,
		setSendMode,
		sendingNow,
		canSubmit: Boolean(running ? runningSubmit : onSubmit),
		textareaRef,
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
		highlightSuggestion: (index: number) => {
			enterCandidates();
			setHighlightedIndex(index);
		},
		selectSuggestion,
		handleKeyDown,
		syncCaret,
		submit,
		onFieldChange: (nextValue: string, nextCaret: number) => {
			resetHistoryNavigation();
			const query = activeSuggestionQuery(nextValue, nextCaret);
			setMentionNavigation(
				query?.trigger === "@"
					? {
							historyKey,
							start: query.start,
							tab:
								activeQuery?.trigger === "@" &&
								activeQuery.start === query.start
									? mentionTab
									: "file",
							categoryFocused: !query.query,
						}
					: null,
			);
			onChange(nextValue);
			setCaret(nextCaret);
			setHighlightedIndex(0);
			setDismissedQuery(null);
		},
	};
}
