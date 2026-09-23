import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";

import { findMessageMatches } from "@/lib/chat-message-search";
import type { ChatMessage } from "@/lib/conversation-types";
import {
	applyTextHighlight,
	clearTextHighlight,
} from "@/lib/dom-text-highlight";
import { Button } from "@/ui";

/** 目标行可能因虚拟列表尚未挂载而找不到高亮区间，限次重试即可。 */
const HIGHLIGHT_RETRY_FRAMES = 30;

export function ChatFindLayer({
	open,
	onClose,
	messages,
	onNavigate,
}: {
	open: boolean;
	onClose: () => void;
	messages: readonly ChatMessage[];
	onNavigate?: (messageIndex: number) => void;
}) {
	const { t } = useTranslation();
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const barRef = useRef<HTMLDivElement>(null);

	const matches = useMemo(
		() => findMessageMatches(messages, query),
		[messages, query],
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
		return applyTextHighlight(
			container,
			current.query,
			current.match
				? {
						messageId: current.match.messageId,
						occurrenceIndex: current.match.occurrenceIndex,
					}
				: undefined,
		);
	}, []);

	useEffect(() => {
		if (open) inputRef.current?.focus();
	}, [open]);

	useEffect(() => {
		if (!open) clearTextHighlight();
	}, [open]);

	// 打开 / 查询词或命中变化时重新定位并高亮。
	/* oxlint-disable react/exhaustive-effect-dependencies -- 依赖用派生出的命中键而非 match 对象身份，避免每次渲染都因身份变化重走 DOM。 */
	useEffect(() => {
		if (!open) return;
		syncHighlight();
		if (activeMessageIndex !== undefined) onNavigate?.(activeMessageIndex);
	}, [open, activeKey, query, activeMessageIndex, syncHighlight, onNavigate]);

	// 首帧渲染时序不稳定：active 区间尚未出现时逐帧重试。
	useEffect(() => {
		if (!open || !activeKey) return;
		let frame = 0;
		let raf = requestAnimationFrame(function tick() {
			const applied = syncHighlight();
			frame += 1;
			if (!applied && frame < HIGHLIGHT_RETRY_FRAMES) {
				raf = requestAnimationFrame(tick);
			}
		});
		return () => cancelAnimationFrame(raf);
	}, [open, activeKey, syncHighlight]);

	// 滚动会挂载/卸载虚拟行，重算可见区域的高亮。
	useEffect(() => {
		if (!open) return;
		let raf = 0;
		const handleScroll = () => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(() => {
				syncHighlight();
			});
		};
		window.addEventListener("scroll", handleScroll, {
			capture: true,
			passive: true,
		});
		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener("scroll", handleScroll, { capture: true });
		};
	}, [open, syncHighlight]);

	if (!open) return null;

	const step = (delta: number) => {
		if (matches.length === 0) return;
		setActiveIndex(
			(current) => (current + delta + matches.length) % matches.length,
		);
	};

	return (
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
	);
}
