import type { ChatMessage } from "@/lib/conversation-types";
import type { SessionHistoryMessageIndexEntry } from "@/lib/sessions";

export const MAX_HYDRATED_HISTORY_MESSAGES = 200;

export type ChatHistoryWindowSnapshot = {
	directory: readonly SessionHistoryMessageIndexEntry[];
	hydrated: ReadonlyMap<number, ChatMessage>;
	runtimeBaseStart: number;
};

const EMPTY_SNAPSHOT: ChatHistoryWindowSnapshot = {
	directory: [],
	hydrated: new Map(),
	runtimeBaseStart: 0,
};

export type ChatHistoryWindowStore = ReturnType<
	typeof createChatHistoryWindowStore
>;

export function createChatHistoryWindowStore(
	maxHydrated = MAX_HYDRATED_HISTORY_MESSAGES,
) {
	let snapshot = EMPTY_SNAPSHOT;
	let pinnedStart = -1;
	let pinnedEnd = -1;
	const listeners = new Set<() => void>();
	const lru = new Map<number, true>();

	const emit = () => {
		for (const listener of listeners) listener();
	};
	const touch = (index: number) => {
		lru.delete(index);
		lru.set(index, true);
	};
	const isPinned = (index: number) =>
		pinnedStart >= 0 && index >= pinnedStart && index <= pinnedEnd;
	const evict = (hydrated: Map<number, ChatMessage>) => {
		while (hydrated.size > maxHydrated) {
			let evicted: number | undefined;
			for (const index of lru.keys()) {
				if (isPinned(index)) continue;
				evicted = index;
				break;
			}
			if (evicted === undefined) break;
			lru.delete(evicted);
			hydrated.delete(evicted);
		}
	};

	return {
		getSnapshot() {
			return snapshot;
		},
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		initialize(
			directory: readonly SessionHistoryMessageIndexEntry[],
			runtimeBaseStart: number,
		) {
			lru.clear();
			pinnedStart = -1;
			pinnedEnd = -1;
			snapshot = {
				directory: [...directory],
				hydrated: new Map(),
				runtimeBaseStart: Math.max(
					0,
					Math.min(runtimeBaseStart, directory.length),
				),
			};
			emit();
		},
		hydrate(startIndex: number, messages: readonly ChatMessage[]) {
			if (messages.length === 0 || snapshot.directory.length === 0) return;
			const hydrated = new Map(snapshot.hydrated);
			let changed = false;
			for (let offset = 0; offset < messages.length; offset += 1) {
				const index = startIndex + offset;
				if (index < 0 || index >= snapshot.runtimeBaseStart) continue;
				const message = messages[offset];
				if (!message) continue;
				hydrated.set(index, message);
				touch(index);
				changed = true;
			}
			if (!changed) return;
			evict(hydrated);
			snapshot = { ...snapshot, hydrated };
			emit();
		},
		setPinnedRange(startIndex: number, endIndex: number) {
			const nextStart = Math.max(0, startIndex);
			const nextEnd = Math.min(snapshot.runtimeBaseStart - 1, endIndex);
			pinnedStart = nextEnd >= nextStart ? nextStart : -1;
			pinnedEnd = nextEnd >= nextStart ? nextEnd : -1;
			if (pinnedStart >= 0) {
				for (let index = pinnedStart; index <= pinnedEnd; index += 1) {
					if (snapshot.hydrated.has(index)) touch(index);
				}
			}
			if (snapshot.hydrated.size <= maxHydrated) return;
			const hydrated = new Map(snapshot.hydrated);
			evict(hydrated);
			if (hydrated.size === snapshot.hydrated.size) return;
			snapshot = { ...snapshot, hydrated };
			emit();
		},
		isRangeHydrated(startIndex: number, endIndex: number) {
			const start = Math.max(0, startIndex);
			const end = Math.min(snapshot.runtimeBaseStart - 1, endIndex);
			if (end < start) return true;
			for (let index = start; index <= end; index += 1) {
				if (!snapshot.hydrated.has(index)) return false;
			}
			return true;
		},
	};
}
