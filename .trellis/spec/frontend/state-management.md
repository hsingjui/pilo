# State Management

> There is no Zustand and no TanStack Query. State is layered by lifetime.

---

## Layers

| Kind                   | Where                                                            | Mechanism                                                               |
| ---------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| App-global prefs/theme | `src/lib/preferences-provider.tsx`, `src/lib/theme-provider.tsx` | React Context + `useState`, exposed via `usePreferences()` / theme hook |
| App-global locale      | `src/i18n/`                                                      | i18next instance + `useTranslation()`; bootstrap before React renders   |
| App shell state        | `src/App.tsx`                                                    | `useState` + orchestration hooks in `src/components/app/`               |
| Feature state          | feature components                                               | `useState` / `useReducer`                                               |
| Hot runtime state      | `src/components/chat/chat-conversation-store.ts`                 | external store + `useSyncExternalStore`                                 |
| Server data            | `src/lib/*.ts`                                                   | `invoke`/`listen`, results held in component/feature state              |

## Rules

- **No new global store library.** Add state at the lowest layer that owns it.
- Context providers are for values read widely and written rarely (preferences,
  theme). Do not put high-frequency streaming state in context — it re-renders
  every consumer.
- For state that changes outside React (Pi event stream, controllers), use the
  external-store pattern so only mounted subscribers re-render:

```ts
export function createChatConversationStore() {
	let snapshot: ConversationState | undefined;
	const listeners = new Set<() => void>();
	return {
		getSnapshot: () => snapshot,
		setSnapshot(next: ConversationState) {
			if (snapshot === next) return;
			snapshot = next;
			for (const listener of listeners) listener();
		},
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
```

Consume it with `useSyncExternalStore(store.subscribe, store.getSnapshot)`.

- Local state that must survive remounts is cached in module/state-cache files
  (`chat-ui-state-cache.ts`, `chat-history-window-store.ts`).
- Locale is app-global low-frequency state owned by the i18n layer. Persist the
  user's choice, resolve system language only when no valid choice exists, and
  never store localized strings in domain/state-machine state.
- Virtualization/scroll state uses dedicated stores/hooks
  (`@tanstack/react-virtual`, `chat-history-window-store`) — keep it out of
  React state to avoid re-render storms.

## Forbidden

- Introducing Zustand/TanStack Query for a new feature without an explicit
  project decision.
- Duplicating server state into a global store as a cache.
- Persisting derived state; recompute from source.
