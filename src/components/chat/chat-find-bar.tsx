import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";

import { ChatFindMatchContext } from "@/components/chat/chat-find-context";
import { useSessionMentions } from "@/components/chat/session-mention-context";
import { findMessageMatches } from "@/lib/chat/chat-message-search";
import type { ChatMessage } from "@/lib/chat/conversation-types";
import { useKeyboardShortcut } from "@/lib/use-keyboard-shortcut";
import {
	applyTextHighlight,
	clearTextHighlight,
} from "@/lib/dom-text-highlight";
import { Button } from "@/ui";

export function ChatFindLayer({
	active,
	open,
	paused = false,
	onOpen,
	onClose,
	messages,
	onNavigate,
	children,
}: {
	children: ReactNode;
	active: boolean;
	open: boolean;
	paused?: boolean;
	onOpen: () => void;
	onClose: () => void;
	messages: readonly ChatMessage[];
	onNavigate?: (messageIndex: number) => void;
}) {
	const { t } = useTranslation();
	const { byValue } = useSessionMentions();
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const [navigationRequest, setNavigationRequest] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const barRef = useRef<HTMLDivElement>(null);
	const pendingRevealRef = useRef(false);
	const pausedSearchRef = useRef(open && paused);
	const focusFrameRef = useRef<number | null>(null);

	useKeyboardShortcut(
		"mod+f",
		() => {
			const element = document.activeElement;
			let selectedText = "";
			if (
				element instanceof HTMLInputElement ||
				element instanceof HTMLTextAreaElement
			) {
				if (
					!(element instanceof HTMLInputElement) ||
					element.type !== "password"
				) {
					selectedText = element.value.slice(
						element.selectionStart ?? 0,
						element.selectionEnd ?? 0,
					);
				}
			} else {
				selectedText = window.getSelection()?.toString() ?? "";
			}
			selectedText = selectedText.replace(/\s+/g, " ").trim();
			if (selectedText && selectedText !== query) {
				setQuery(selectedText);
				setActiveIndex(0);
			}
			onOpen();
			if (focusFrameRef.current !== null)
				cancelAnimationFrame(focusFrameRef.current);
			focusFrameRef.current = requestAnimationFrame(() => {
				focusFrameRef.current = null;
				inputRef.current?.focus();
				inputRef.current?.select();
			});
		},
		{ enabled: active && !paused },
	);

	useEffect(
		() => () => {
			if (focusFrameRef.current !== null)
				cancelAnimationFrame(focusFrameRef.current);
		},
		[],
	);

	const matches = useMemo(
		() => (open ? findMessageMatches(messages, query, byValue) : []),
		[open, messages, query, byValue],
	);
	const safeIndex =
		matches.length === 0 ? 0 : Math.min(activeIndex, matches.length - 1);
	const match = matches[safeIndex];
	const activeKey = match ? `${match.messageId}#${match.occurrenceIndex}` : "";
	const activeMessageIndex = match?.messageIndex;

	const latestRef = useRef({ open, query, match });
	useEffect(() => {
		latestRef.current = { open, query, match };
	});

	// 高亮容器为查找条所在的相对定位容器，其内包含会话视口。
	const syncHighlight = useCallback(() => {
		const current = latestRef.current;
		if (!current.open) return false;
		const container = barRef.current?.parentElement;
		if (!container) return false;
		const applied = applyTextHighlight(
			container,
			current.query,
			current.match,
			pendingRevealRef.current,
		);
		if (applied) pendingRevealRef.current = false;
		return applied;
	}, []);

	useEffect(() => {
		if (!open) return;
		inputRef.current?.focus();
		inputRef.current?.select();
	}, [open]);

	// 显式导航即使命中未变（只有一个结果），也要重新定位。
	/* oxlint-disable react/exhaustive-effect-dependencies -- 使用命中键避免对象身份变化触发定位；navigationRequest 保留重复导航。 */
	useEffect(() => {
		const resuming = pausedSearchRef.current && !paused;
		pausedSearchRef.current = open && paused;
		if (!open || paused) {
			pendingRevealRef.current = false;
			return;
		}
		// 返回聊天标签时只刷新高亮，不重新定位旧命中。
		if (!resuming) {
			pendingRevealRef.current = true;
			if (activeMessageIndex !== undefined) onNavigate?.(activeMessageIndex);
		}
		const raf = requestAnimationFrame(() => syncHighlight());
		return () => cancelAnimationFrame(raf);
	}, [
		open,
		paused,
		activeKey,
		query,
		activeMessageIndex,
		navigationRequest,
		syncHighlight,
		onNavigate,
	]);

	// 滚动、展开工作过程与 Markdown 异步渲染都会改变可高亮的 DOM。
	useEffect(() => {
		if (!open || paused) return;
		let raf = 0;
		const handleScroll = () => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(() => {
				syncHighlight();
			});
		};
		const container = barRef.current?.parentElement;
		const observer = new MutationObserver(handleScroll);
		if (container) {
			observer.observe(container, {
				childList: true,
				characterData: true,
				subtree: true,
			});
		}
		window.addEventListener("scroll", handleScroll, {
			capture: true,
			passive: true,
		});
		return () => {
			cancelAnimationFrame(raf);
			observer.disconnect();
			window.removeEventListener("scroll", handleScroll, { capture: true });
			clearTextHighlight();
		};
	}, [open, paused, syncHighlight]);

	const step = (delta: number) => {
		if (matches.length === 0) return;
		setActiveIndex(
			(current) => (current + delta + matches.length) % matches.length,
		);
		setNavigationRequest((current) => current + 1);
	};

	return (
		<ChatFindMatchContext.Provider value={open ? (match ?? null) : null}>
			{children}
			{open ? (
				<div
					ref={barRef}
					className="absolute end-3 top-2 z-20 flex items-center gap-1 rounded-lg border border-border/70 bg-popover/95 py-1 ps-2 pe-1 shadow-md backdrop-blur"
				>
					<Search className="size-3.5 shrink-0 text-muted-foreground" />
					<input
						ref={inputRef}
						value={query}
						aria-label={t("chat.find.placeholder")}
						placeholder={t("chat.find.placeholder")}
						className="h-6 w-44 min-w-0 bg-transparent text-sm text-foreground outline-hidden placeholder:text-muted-foreground"
						onChange={(event) => {
							setQuery(event.target.value);
							setActiveIndex(0);
						}}
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								event.preventDefault();
								onClose();
								return;
							}
							if (event.key === "Enter") {
								event.preventDefault();
								step(event.shiftKey ? -1 : 1);
							}
						}}
					/>
					<span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground">
						{matches.length > 0
							? t("chat.find.matchCount", {
									current: safeIndex + 1,
									total: matches.length,
								})
							: query.trim()
								? t("chat.find.noMatches")
								: ""}
					</span>
					<Button
						variant="ghost"
						size="icon"
						className="size-6"
						disabled={matches.length === 0}
						aria-label={t("chat.find.previous")}
						onClick={() => step(-1)}
					>
						<ChevronUp className="size-3.5" />
					</Button>
					<Button
						variant="ghost"
						size="icon"
						className="size-6"
						disabled={matches.length === 0}
						aria-label={t("chat.find.next")}
						onClick={() => step(1)}
					>
						<ChevronDown className="size-3.5" />
					</Button>
					<Button
						variant="ghost"
						size="icon"
						className="size-6"
						aria-label={t("chat.find.close")}
						onClick={onClose}
					>
						<X className="size-3.5" />
					</Button>
				</div>
			) : null}
		</ChatFindMatchContext.Provider>
	);
}
