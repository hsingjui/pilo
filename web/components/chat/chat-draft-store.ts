export type ChatDraftStore = ReturnType<typeof createChatDraftStore>;

// The composer subscribes to text; runtime actions read it only when needed.
export function createChatDraftStore(initialValue = "") {
	let value = initialValue;
	const listeners = new Set<(previous: string) => void>();
	return {
		getSnapshot: () => value,
		setValue(next: string) {
			if (next === value) return;
			const previous = value;
			value = next;
			for (const listener of listeners) listener(previous);
		},
		subscribe(listener: (previous: string) => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
