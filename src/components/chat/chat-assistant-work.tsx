import {
	memo,
	useCallback,
	useEffect,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";

import {
	AssistantActivityView,
	type AssistantActivity,
} from "@/components/chat/chat-activity";
import { toggleChatExpansionWithAnchor } from "@/components/chat/chat-expansion-anchor";
import { useChatExpansionState } from "@/components/chat/chat-expansion-state";
import { ChatMarkdown } from "@/components/chat/chat-markdown";
import type { AssistantContentItem } from "@/lib/chat-activity-state";
import type { ChatMessage } from "@/lib/conversation-types";
import { formatWorkDuration } from "@/lib/format-duration";
import { usePreferences } from "@/lib/preferences-provider";
import { cn } from "@/lib/utils";

const LARGE_MESSAGE_PREVIEW_CHARS = 8_000;
const WORK_ACTIVITY_INITIAL_ITEMS = 18;
const WORK_ACTIVITY_REVEAL_ITEMS = 24;
const WORK_ACTIVITY_REVEAL_MARGIN_PX = 640;

function WorkActivityRevealSentinel({ onReveal }: { onReveal: () => void }) {
	const sentinelRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const sentinel = sentinelRef.current;
		if (!sentinel) return;
		const viewport = sentinel.closest<HTMLElement>(".chat-scrollbar");
		if (!viewport || typeof IntersectionObserver === "undefined") {
			const frame = requestAnimationFrame(onReveal);
			return () => cancelAnimationFrame(frame);
		}

		let armed = true;
		const observer = new IntersectionObserver(
			(entries) => {
				const entry = entries[0];
				if (!entry) return;
				if (!entry.isIntersecting) {
					armed = true;
					return;
				}
				if (!armed) return;
				armed = false;
				onReveal();
			},
			{
				root: viewport,
				rootMargin: `${WORK_ACTIVITY_REVEAL_MARGIN_PX}px 0px`,
			},
		);
		observer.observe(sentinel);
		return () => observer.disconnect();
	}, [onReveal]);

	return <div ref={sentinelRef} className="h-px w-full" aria-hidden="true" />;
}

function markdownPreview(text: string) {
	let preview = text.slice(0, LARGE_MESSAGE_PREVIEW_CHARS);
	const lastLineBreak = preview.lastIndexOf("\n");
	if (lastLineBreak > LARGE_MESSAGE_PREVIEW_CHARS * 0.75) {
		preview = preview.slice(0, lastLineBreak);
	}
	const fenceCount = preview.match(/```/g)?.length ?? 0;
	if (fenceCount % 2 === 1) preview += "\n```";
	return `${preview}\n\n…`;
}

const CollapsibleMessageBody = memo(function CollapsibleMessageBody({
	text,
	markdown = false,
	streaming = false,
	collapseDisabled = false,
}: {
	text: string;
	markdown?: boolean;
	streaming?: boolean;
	collapseDisabled?: boolean;
}) {
	const { t } = useTranslation();
	const { collapseLongMessages } = usePreferences();
	const collapsible =
		collapseLongMessages &&
		!collapseDisabled &&
		!streaming &&
		text.length > LARGE_MESSAGE_PREVIEW_CHARS;
	const [expanded, setExpanded] = useState(false);
	const visibleText = collapsible && !expanded ? markdownPreview(text) : text;

	return (
		<div className="min-w-0" data-chat-expansion-root>
			{markdown ? (
				<ChatMarkdown text={visibleText} isStreaming={streaming} />
			) : (
				<p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
					{visibleText}
				</p>
			)}
			{collapsible ? (
				<button
					type="button"
					className="mt-2 inline-flex items-center gap-1 text-2xs text-muted-foreground transition-colors hover:text-foreground"
					onClick={(event) =>
						toggleChatExpansionWithAnchor(event.currentTarget, () =>
							setExpanded((value) => !value),
						)
					}
				>
					<ChevronDown
						className={cn(
							"size-3 transition-transform duration-150 ease-out",
							expanded && "rotate-180",
						)}
					/>
					{expanded ? t("chat.collapseMessage") : t("chat.expandMessage")}
				</button>
			) : null}
		</div>
	);
});

export function getAssistantMessageContent(
	message: Extract<ChatMessage, { role: "assistant" }>,
): AssistantContentItem[] {
	if (message.content) return message.content;

	const content: AssistantContentItem[] = [];
	if (message.activity) content.push(...message.activity);
	if (message.text) {
		content.push({
			id: `${message.id}-text`,
			type: "text",
			text: message.text,
		});
	}
	return content;
}

export function renderAssistantContentNodes({
	messageId,
	content,
	streaming,
	keepTextExpanded = false,
	durationMs,
	followedByTextAfterContent = false,
}: {
	messageId: string;
	content: AssistantContentItem[];
	streaming: boolean;
	keepTextExpanded?: boolean;
	durationMs?: number;
	followedByTextAfterContent?: boolean;
}) {
	const nodes: ReactNode[] = [];
	let firstActivityGroup = true;

	for (let index = 0; index < content.length; index += 1) {
		const item = content[index];
		if (item.type === "text") {
			if (item.text) {
				nodes.push(
					<CollapsibleMessageBody
						key={item.id}
						text={item.text}
						markdown
						streaming={streaming && index === content.length - 1}
						collapseDisabled={keepTextExpanded}
					/>,
				);
			}
			continue;
		}

		const group: AssistantActivity[] = [];
		const groupStart = index;
		while (index < content.length && content[index].type !== "text") {
			group.push(content[index] as AssistantActivity);
			index += 1;
		}
		index -= 1;
		const groupKey = group[0]?.id ?? `activity-${groupStart}`;
		const nextItem = content[index + 1];
		const followedByText =
			(nextItem?.type === "text" && nextItem.text.length > 0) ||
			(index === content.length - 1 && followedByTextAfterContent);
		nodes.push(
			<div key={`${messageId}-${groupKey}`}>
				<AssistantActivityView
					activity={group}
					expansionKey={`${messageId}:${groupKey}`}
					followedByText={followedByText}
					durationMs={firstActivityGroup ? durationMs : undefined}
				/>
			</div>,
		);
		firstActivityGroup = false;
	}

	return nodes;
}

function ProgressiveAssistantWorkContent({
	messageId,
	content,
	active,
	streaming,
	keepTextExpanded,
	followedByTextAfterContent,
}: {
	messageId: string;
	content: AssistantContentItem[];
	active: boolean;
	streaming: boolean;
	keepTextExpanded: boolean;
	followedByTextAfterContent: boolean;
}) {
	const contentLengthRef = useRef(content.length);
	useEffect(() => {
		contentLengthRef.current = content.length;
	}, [content.length]);
	const [requestedVisibleCount, setRequestedVisibleCount] = useState(() =>
		Math.min(content.length, WORK_ACTIVITY_INITIAL_ITEMS),
	);
	const visibleCount = Math.min(
		content.length,
		Math.max(requestedVisibleCount, WORK_ACTIVITY_INITIAL_ITEMS),
	);
	const startIndex = active ? Math.max(0, content.length - visibleCount) : 0;
	const endIndex = active ? content.length : visibleCount;
	const hasHiddenBefore = startIndex > 0;
	const hasHiddenAfter = endIndex < content.length;
	const visibleContent = content.slice(startIndex, endIndex);
	const revealMore = useCallback(() => {
		setRequestedVisibleCount((current) =>
			Math.min(
				contentLengthRef.current,
				Math.max(current, WORK_ACTIVITY_INITIAL_ITEMS) +
					WORK_ACTIVITY_REVEAL_ITEMS,
			),
		);
	}, []);

	return (
		<>
			{hasHiddenBefore ? (
				<WorkActivityRevealSentinel onReveal={revealMore} />
			) : null}
			{renderAssistantContentNodes({
				messageId,
				content: visibleContent,
				streaming,
				keepTextExpanded,
				followedByTextAfterContent:
					hasHiddenAfter || followedByTextAfterContent,
			})}
			{hasHiddenAfter ? (
				<WorkActivityRevealSentinel onReveal={revealMore} />
			) : null}
		</>
	);
}

export function AssistantWorkedRegion({
	messageId,
	content,
	active = false,
	streaming = false,
	keepTextExpanded = false,
	durationMs,
	followedByTextAfterContent = false,
}: {
	messageId: string;
	content: AssistantContentItem[];
	active?: boolean;
	streaming?: boolean;
	keepTextExpanded?: boolean;
	durationMs?: number;
	followedByTextAfterContent?: boolean;
}) {
	const { t } = useTranslation();
	const { collapseCompletedActivity, showWorkDuration } = usePreferences();
	const [open, setOpen] = useChatExpansionState(
		`worked:${messageId}:${active ? "active" : "complete"}`,
		active || !collapseCompletedActivity,
	);
	const durationLabel =
		showWorkDuration && durationMs !== undefined
			? formatWorkDuration(durationMs, {
					hour: t("common.hour"),
					minute: t("common.minute"),
					second: t("common.second"),
				})
			: "";

	return (
		<div
			className="mb-1 mt-0.5 w-full text-muted-foreground"
			data-chat-expansion-root
		>
			<button
				type="button"
				className="group/work flex w-full items-center gap-1.5 rounded-md py-0.5 pr-1 text-left text-sm font-medium leading-snug text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
				onClick={(event) =>
					toggleChatExpansionWithAnchor(event.currentTarget, () =>
						setOpen((value) => !value),
					)
				}
				aria-expanded={open}
			>
				<ChevronRight
					className={cn(
						"size-3.5 shrink-0 transition-transform duration-150 ease-out",
						open && "rotate-90",
					)}
				/>
				<span className="min-w-0 flex-1 truncate">
					{durationLabel
						? t("chat.workDuration", { duration: durationLabel })
						: t("chat.workActivity")}
				</span>
			</button>
			{open ? (
				<div className="pt-0.5">
					<ProgressiveAssistantWorkContent
						messageId={messageId}
						content={content}
						active={active}
						streaming={streaming}
						keepTextExpanded={keepTextExpanded}
						followedByTextAfterContent={followedByTextAfterContent}
					/>
				</div>
			) : null}
		</div>
	);
}
