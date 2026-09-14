import type { ChatSession } from "@/components/chat/chat-page";
import type { ChatImageAttachment } from "@/lib/chat-submission";
import type { SidebarSession } from "@/components/sidebar/types";
import type { Project } from "@/lib/projects";
import type { SessionIndexEntry } from "@/lib/sessions";

let draftSessionSequence = 0;
const sidebarSessionCache = new WeakMap<SessionIndexEntry, SidebarSession>();

function sessionDate(session: SessionIndexEntry) {
	const fileMtimeMs = Number(session.fileMtimeNs) / 1_000_000;
	if (Number.isFinite(fileMtimeMs) && fileMtimeMs > 0) {
		return new Date(fileMtimeMs);
	}
	const value = session.lastMessageAt ?? session.updatedAt ?? session.createdAt;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? new Date(session.indexedAtMs) : date;
}

export function toSidebarSession(session: SessionIndexEntry): SidebarSession {
	const cached = sidebarSessionCache.get(session);
	if (cached) return cached;
	const sidebarSession: SidebarSession = {
		id: session.piSessionId,
		title:
			session.titleOverride ??
			session.name ??
			session.firstUserMessagePreview ??
			"新对话",
		preview:
			session.titleOverride || session.name
				? session.firstUserMessagePreview
				: null,
		sessionPath: session.sessionPath,
		projectId: session.projectId,
		latestMessageAt: sessionDate(session),
	};
	sidebarSessionCache.set(session, sidebarSession);
	return sidebarSession;
}

export function mergeSidebarSessionsWithOpenChats(
	indexedSessions: readonly SidebarSession[],
	openedChats: readonly OpenChat[],
	busyControllerIds: ReadonlySet<string>,
	now = new Date(),
): SidebarSession[] {
	const openedByIndexedSession = new Map<string, OpenChat>();
	for (const entry of openedChats) {
		const sessionId = entry.piSessionId ?? entry.session.id;
		openedByIndexedSession.set(
			chatUiStateKey(entry.session.projectRecord.id, sessionId),
			entry,
		);
	}

	const indexedKeys = new Set<string>();
	const mergedIndexed = indexedSessions.map((session) => {
		const key = chatUiStateKey(session.projectId, session.id);
		indexedKeys.add(key);
		const opened = openedByIndexedSession.get(key);
		const active = opened ? busyControllerIds.has(opened.controllerId) : false;
		return Boolean(session.active) === active
			? session
			: { ...session, active };
	});

	const pending: SidebarSession[] = [];
	for (let index = openedChats.length - 1; index >= 0; index -= 1) {
		const entry = openedChats[index];
		if (entry.session.temporary) continue;
		const sessionId = entry.piSessionId ?? entry.session.id;
		const key = chatUiStateKey(entry.session.projectRecord.id, sessionId);
		if (indexedKeys.has(key)) continue;
		pending.push({
			id: sessionId,
			title: entry.session.title || "新对话",
			preview: entry.initialMessage?.trim() || null,
			sessionPath: entry.session.sessionPath ?? "",
			projectId: entry.session.projectRecord.id,
			latestMessageAt: now,
			active: busyControllerIds.has(entry.controllerId),
		});
	}

	return [...pending, ...mergedIndexed];
}

export function createDraftSessionId() {
	draftSessionSequence += 1;
	return `draft-session-${Date.now()}-${draftSessionSequence}`;
}

export function createTemporarySessionId() {
	draftSessionSequence += 1;
	return `temporary-session-${Date.now()}-${draftSessionSequence}`;
}

export function projectRelativePath(project: Project, candidate: string) {
	const root = project.path.replace(/\\/g, "/").replace(/\/+$/, "");
	const path = candidate.trim().replace(/\\/g, "/");
	if (!path || path === root) return null;
	if (path.startsWith(`${root}/`)) return path.slice(root.length + 1);
	if (path.startsWith("./")) return path.slice(2);
	if (path.startsWith("/") || /^[A-Za-z]:\//.test(path)) return null;
	if (path.split("/").some((part) => part === "..")) return null;
	return path;
}

export const MAX_OPEN_CHAT_CONTROLLERS = 16;
export const MAX_OPEN_CHAT_ESTIMATED_HISTORY_BYTES = 64 * 1024 * 1024;
const OPEN_CHAT_HISTORY_MEMORY_MULTIPLIER = 2;

function estimatedOpenChatHistoryBytes(entry: OpenChat) {
	return (
		(entry.session.historyFileSize ?? 0) * OPEN_CHAT_HISTORY_MEMORY_MULTIPLIER
	);
}

export function chatUiStateKey(projectId: string, sessionId: string) {
	return `${projectId}:${sessionId}`;
}

export type OpenChat = {
	controllerId: string;
	uiStateKey: string;
	session: ChatSession;
	initialMessage?: string;
	initialImages?: ChatImageAttachment[];
	piSessionId?: string;
};

export function indexedChatSession(
	session: SessionIndexEntry,
	project: Project,
): ChatSession {
	return {
		id: session.piSessionId,
		title:
			session.titleOverride ??
			session.name ??
			session.firstUserMessagePreview ??
			"新对话",
		projectRecord: project,
		sessionPath: session.sessionPath,
		historyFileSize: session.fileSize,
		historyFileMtimeNs: session.fileMtimeNs,
	};
}

export function upsertOpenedChat(
	current: OpenChat[],
	session: ChatSession,
	initialMessage?: string,
	initialImages?: readonly ChatImageAttachment[],
): OpenChat[] {
	const index = current.findIndex(
		(entry) =>
			entry.session.projectRecord.id === session.projectRecord.id &&
			(entry.session.id === session.id || entry.piSessionId === session.id),
	);
	if (index < 0) {
		const controllerId = chatUiStateKey(session.projectRecord.id, session.id);
		return [
			...current,
			{
				controllerId,
				uiStateKey: controllerId,
				session,
				initialMessage,
				initialImages: initialImages ? [...initialImages] : undefined,
			},
		];
	}

	const existing = current[index];
	const nextInitialMessage = existing.initialMessage ?? initialMessage;
	const nextInitialImages =
		existing.initialImages ?? (initialImages ? [...initialImages] : undefined);
	const identifiedDraftMatch =
		existing.piSessionId === session.id && existing.session.id !== session.id;
	const nextSession = identifiedDraftMatch
		? {
				...existing.session,
				title: session.title,
				projectRecord: session.projectRecord,
				historyFileSize: session.historyFileSize,
				historyFileMtimeNs: session.historyFileMtimeNs,
			}
		: {
				...existing.session,
				...session,
			};
	const sessionChanged =
		existing.session.id !== nextSession.id ||
		existing.session.title !== nextSession.title ||
		existing.session.temporary !== nextSession.temporary ||
		existing.session.projectRecord !== nextSession.projectRecord ||
		existing.session.sessionPath !== nextSession.sessionPath ||
		existing.session.historyFileSize !== nextSession.historyFileSize ||
		existing.session.historyFileMtimeNs !== nextSession.historyFileMtimeNs;
	if (
		!sessionChanged &&
		nextInitialMessage === existing.initialMessage &&
		nextInitialImages === existing.initialImages
	) {
		return current;
	}

	const next = current.slice();
	next[index] = {
		...existing,
		initialMessage: nextInitialMessage,
		initialImages: nextInitialImages,
		session: sessionChanged ? nextSession : existing.session,
	};
	return next;
}

export function identifyOpenedChat(
	current: OpenChat[],
	controllerId: string,
	piSessionId: string,
): OpenChat[] {
	return current.map((entry) => {
		if (entry.controllerId !== controllerId) return entry;
		const uiStateKey = chatUiStateKey(
			entry.session.projectRecord.id,
			piSessionId,
		);
		if (entry.piSessionId === piSessionId && entry.uiStateKey === uiStateKey) {
			return entry;
		}
		return { ...entry, piSessionId, uiStateKey };
	});
}

export function syncOpenedChatSessionMetadata(
	current: OpenChat[],
	indexedSessions: readonly SessionIndexEntry[],
): OpenChat[] {
	let changed = false;
	const next = current.map((entry) => {
		const sessionId = entry.piSessionId ?? entry.session.id;
		const indexed = indexedSessions.find(
			(candidate) =>
				candidate.projectId === entry.session.projectRecord.id &&
				candidate.piSessionId === sessionId,
		);
		if (!indexed) return entry;

		const title =
			indexed.titleOverride ??
			indexed.name ??
			indexed.firstUserMessagePreview ??
			"新对话";
		const sessionPath =
			entry.session.sessionPath ??
			(entry.piSessionId ? undefined : indexed.sessionPath);
		if (
			entry.session.title === title &&
			entry.session.sessionPath === sessionPath &&
			entry.session.historyFileSize === indexed.fileSize &&
			entry.session.historyFileMtimeNs === indexed.fileMtimeNs
		) {
			return entry;
		}

		changed = true;
		return {
			...entry,
			session: {
				...entry.session,
				title,
				sessionPath,
				historyFileSize: indexed.fileSize,
				historyFileMtimeNs: indexed.fileMtimeNs,
			},
		};
	});
	return changed ? next : current;
}

export function touchOpenedChat(
	current: OpenChat[],
	session: ChatSession,
	initialMessage?: string,
	initialImages?: readonly ChatImageAttachment[],
): OpenChat[] {
	const next = upsertOpenedChat(
		current,
		session,
		initialMessage,
		initialImages,
	);
	const index = next.findIndex(
		(entry) =>
			entry.session.projectRecord.id === session.projectRecord.id &&
			(entry.session.id === session.id || entry.piSessionId === session.id),
	);
	if (index < 0 || index === next.length - 1) return next;
	const touched = next[index];
	return [...next.slice(0, index), ...next.slice(index + 1), touched];
}

export function trimOpenedChats(
	current: OpenChat[],
	protectedControllerIds: ReadonlySet<string>,
	limit = MAX_OPEN_CHAT_CONTROLLERS,
	maxEstimatedHistoryBytes = MAX_OPEN_CHAT_ESTIMATED_HISTORY_BYTES,
): OpenChat[] {
	let remainingCount = current.length;
	let remainingEstimatedHistoryBytes = current.reduce(
		(total, entry) => total + estimatedOpenChatHistoryBytes(entry),
		0,
	);
	if (
		remainingCount <= limit &&
		remainingEstimatedHistoryBytes <= maxEstimatedHistoryBytes
	) {
		return current;
	}

	const newestControllerId = current[current.length - 1]?.controllerId;
	const next = current.filter((entry) => {
		const overLimit = remainingCount > limit;
		const overBudget =
			remainingEstimatedHistoryBytes > maxEstimatedHistoryBytes;
		if (
			(overLimit || overBudget) &&
			entry.controllerId !== newestControllerId &&
			!protectedControllerIds.has(entry.controllerId)
		) {
			remainingCount -= 1;
			remainingEstimatedHistoryBytes -= estimatedOpenChatHistoryBytes(entry);
			return false;
		}
		return true;
	});
	return next.length === current.length ? current : next;
}
