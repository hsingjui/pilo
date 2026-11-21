import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { MessageSquare } from "lucide-react";
import { toast } from "sonner";

import type { SidebarSession } from "@/components/sidebar/types";
import type { Project } from "@/lib/api/projects";
import {
	sessionMentionValue,
	type SessionMention,
} from "@shared/chat/session-mentions";

const EMPTY_MENTIONS: readonly SessionMention[] = [];
const MentionContext = createContext(EMPTY_MENTIONS);
const ConnectionContext = createContext("");
type DropTarget = {
	connectionId: string;
	insert: (mention: SessionMention) => void;
};
type MentionDrag = {
	isDragging: boolean;
	start: (
		event: ReactPointerEvent<HTMLElement>,
		projectId: string,
		path: string,
		suppressClick: () => void,
	) => void;
	register: (element: HTMLElement, target: DropTarget) => () => void;
};
const DragContext = createContext<MentionDrag | null>(null);

export function SessionMentionProvider({
	projects,
	sessions,
	desktopDrag = false,
	children,
}: {
	projects: readonly Project[];
	sessions: readonly SidebarSession[];
	desktopDrag?: boolean;
	children: ReactNode;
}) {
	const { t } = useTranslation();
	const mentions = useMemo(() => {
		const projectMap = new Map(
			projects.map((project) => [project.id, project]),
		);
		return sessions.flatMap((session): SessionMention[] => {
			const project = projectMap.get(session.projectId);
			if (!project || !session.sessionPath) return [];
			return [
				{
					connectionId: project.connection.id,
					projectId: project.id,
					path: session.sessionPath,
					title: session.title,
					projectName: project.name,
					updatedAt: session.latestMessageAt.getTime(),
				},
			];
		});
	}, [projects, sessions]);
	const targetsRef = useRef(new Map<HTMLElement, DropTarget>());
	const stopRef = useRef<(() => void) | null>(null);
	const ghostRef = useRef<HTMLDivElement>(null);
	const [dragged, setDragged] = useState<{
		mention: SessionMention;
		x: number;
		y: number;
	} | null>(null);
	useEffect(() => () => stopRef.current?.(), []);

	const register = useCallback((element: HTMLElement, target: DropTarget) => {
		targetsRef.current.set(element, target);
		return () => {
			targetsRef.current.delete(element);
		};
	}, []);
	const start = useCallback<MentionDrag["start"]>(
		(event, projectId, path, suppressClick) => {
			if (!desktopDrag || event.button !== 0 || event.pointerType !== "mouse")
				return;
			if (
				event.target instanceof Element &&
				event.target.closest("button, input, [role=menuitem]")
			)
				return;
			const mention = mentions.find(
				(entry) => entry.projectId === projectId && entry.path === path,
			);
			if (!mention) return;
			stopRef.current?.();
			const { clientX, clientY, pointerId, currentTarget: source } = event;
			let dragging = false;
			let hovered: HTMLElement | null = null;
			const clearHover = () => {
				hovered?.removeAttribute("data-session-drop-state");
				hovered = null;
			};
			const move = (next: PointerEvent) => {
				if (next.pointerId !== pointerId) return;
				if (
					!dragging &&
					Math.hypot(next.clientX - clientX, next.clientY - clientY) < 6
				)
					return;
				if (!source.isConnected) {
					stop();
					return;
				}
				if (!dragging) {
					dragging = true;
					source.setPointerCapture(pointerId);
					suppressClick();
					setDragged({ mention, x: next.clientX + 12, y: next.clientY + 12 });
				}
				next.preventDefault();
				if (ghostRef.current)
					ghostRef.current.style.transform = `translate(${next.clientX + 12}px, ${next.clientY + 12}px)`;
				clearHover();
				const element = document
					.elementFromPoint(next.clientX, next.clientY)
					?.closest<HTMLElement>("[data-session-mention-target]");
				if (element && targetsRef.current.has(element)) {
					hovered = element;
					element.setAttribute(
						"data-session-drop-state",
						targetsRef.current.get(element)?.connectionId ===
							mention.connectionId
							? "allowed"
							: "denied",
					);
				}
			};
			const stop = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", finish, true);
				window.removeEventListener("pointercancel", cancel);
				window.removeEventListener("blur", cancel);
				window.removeEventListener("keydown", keydown);
				source.removeEventListener("lostpointercapture", cancel);
				if (source.hasPointerCapture(pointerId))
					source.releasePointerCapture(pointerId);
				clearHover();
				setDragged(null);
				stopRef.current = null;
			};
			const finish = (next: PointerEvent) => {
				if (next.pointerId !== pointerId) return;
				if (dragging) {
					next.preventDefault();
					next.stopPropagation();
					const element = document
						.elementFromPoint(next.clientX, next.clientY)
						?.closest<HTMLElement>("[data-session-mention-target]");
					const target = element ? targetsRef.current.get(element) : undefined;
					if (target?.connectionId === mention.connectionId)
						target.insert(mention);
					else if (target)
						toast.info(t("chat.sessionMentionConnectionMismatch"));
				}
				stop();
			};
			const cancel = () => stop();
			const keydown = (next: KeyboardEvent) => {
				if (next.key === "Escape") stop();
			};
			stopRef.current = stop;
			window.addEventListener("pointermove", move, { passive: false });
			window.addEventListener("pointerup", finish, true);
			window.addEventListener("pointercancel", cancel);
			window.addEventListener("blur", cancel);
			window.addEventListener("keydown", keydown);
			source.addEventListener("lostpointercapture", cancel);
		},
		[desktopDrag, mentions, t],
	);
	const isDragging = dragged !== null;
	const drag = useMemo(
		() => (desktopDrag ? { isDragging, start, register } : null),
		[desktopDrag, isDragging, start, register],
	);
	return (
		<MentionContext.Provider value={mentions}>
			<DragContext.Provider value={drag}>
				{children}
				{dragged ? (
					<div
						ref={ghostRef}
						style={{ transform: `translate(${dragged.x}px, ${dragged.y}px)` }}
						className="pointer-events-none fixed left-0 top-0 z-50 flex max-w-64 items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs shadow-md"
						aria-hidden="true"
					>
						<MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
						<span className="truncate">{dragged.mention.title}</span>
					</div>
				) : null}
			</DragContext.Provider>
		</MentionContext.Provider>
	);
}

export function SessionMentionScope({
	connectionId,
	children,
}: {
	connectionId: string;
	children: ReactNode;
}) {
	return (
		<ConnectionContext.Provider value={connectionId}>
			{children}
		</ConnectionContext.Provider>
	);
}

export function useSessionMentions() {
	const all = useContext(MentionContext);
	const connectionId = useContext(ConnectionContext);
	const mentions = useMemo(
		() => all.filter((mention) => mention.connectionId === connectionId),
		[all, connectionId],
	);
	const byValue = useMemo(
		() =>
			new Map(
				mentions.map((mention) => [sessionMentionValue(mention.path), mention]),
			),
		[mentions],
	);
	return { mentions, byValue, connectionId };
}

export function useSessionMentionDrag() {
	return useContext(DragContext);
}
