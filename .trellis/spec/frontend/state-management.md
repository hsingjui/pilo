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
| Server data            | `src/lib/api/*.ts`                                                   | `invoke`/`listen`, results held in component/feature state              |

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

WebUI uses this same conversation store. `RemoteConversationViewport` subscribes
to the full snapshot and renders the shared `ChatConversationViewport`; the
workspace hook subscribes only to a cached projection of activity, message
count, pending users and interruption status. Keep the projection reference
stable on text/thinking/tool deltas, or the entire shell re-renders again.
The setter updates the projection before publishing the store snapshot.

Web event frames coalesce adjacent deltas and use `reduceConversationActions`.
Flush at user/non-assistant boundaries and after `assistant_turn_end` before
deciding whether the next action must adopt an external live turn. A value the
reducer derives from event timing (for example a thinking block duration) comes
from the Host event timestamp carried by the action; when it is absent, leave the
value undefined instead of substituting the client clock. Fork actions
obtain the latest messages on click, before their first await, rather than
subscribing shell callbacks to every streaming message change.

The assistant footer's `ChatMessage.time` is formatted from the turn-end
timestamp by the shared `endTurn` reducer, including abort/error and segment
boundaries; it must not keep the optimistic placeholder's submission time.
`ChatMessage.timestampMs` remains the message creation timestamp for turn
revival. `toConversationAction` preserves `assistant_message_end.timestampMs`
so reconnect replay uses Host time rather than the browser's processing time.
History replay uses the persisted `assistant_turn_end.timestampMs`. When an
end event has no timestamp, the existing reducer clock fallback applies.

- Local state that must survive remounts is cached in module/state-cache files
  (`chat-ui-state-cache.ts`, `chat-history-window-store.ts`).
- Locale is app-global low-frequency state owned by the i18n layer. Persist the
  user's choice, resolve system language only when no valid choice exists, and
  never store localized strings in domain/state-machine state.
- Virtualization/scroll state uses dedicated stores/hooks
  (`@tanstack/react-virtual`, `chat-history-window-store`) — keep it out of
  React state to avoid re-render storms.

## Reply-Segment Usage

### 1. Scope / Trigger

Steering can insert a user message before `agent_settled`. Desktop and WebUI
must preserve the preceding reply segment's usage without ending the agent run.

### 2. Signatures

`assistant_usage_update { generation, usage: TokenUsage }` maps to
`ConversationEvent { type: "assistant_usage_update", usage }`.

### 3. Contracts

- `PiEventAdapter` emits the cumulative usage update before `user_message_start`,
  then resets its accumulator. Only `agent_settled` ends the agent run.
- The shared reducer replaces the active assistant's usage without changing
  streaming/completion. Pending submissions route it to `previousTurn`, just
  like text; it must not create a message or adopt a new running turn.
- Live `message_end` and historical projection both accumulate `assistant` and
  `toolResult` usage once. Never add the same usage again from `agent_end`.

### 4. Validation / Error Matrix

Missing usage emits no update; an update without an active assistant is ignored.
Stop/discard handling and the stopped-message footer remain unchanged.

### 5. Good / Base / Bad Cases

Good: steer preserves A's usage before B starts. Base: an unsteered reply receives
usage at settle. Bad: clearing A's usage, or emitting a false turn completion.

### 6. Tests Required

Regression coverage lives in `runtime/pi_events/tests.rs`,
`runtime/session_history/tests.rs` and `tests/unit/conversation-reducer.test.ts`:
steer ordering, repeated steer, pending previous-turn routing, no-active updates
and live/history tool-result usage parity. The history stats fixture includes
`t1` in its turn assertions: 97 tokens / $0.032, matching live accumulation.

### 7. Wrong vs Correct

Wrong: send `assistant_message_end` at steer and release runtime ownership.
Correct: send usage-only metadata, then let the user echo split the conversation.

## Shared Theme Preferences

- Theme mode, family, active custom CSS/name and saved custom themes are owned
  by Host SQLite, not device preferences. `ThemeProvider` owns their React
  projection and CSS injection; `PreferencesProvider` owns device-local fonts
  and other preferences only.
- `AppearanceSettings` is desktop-only and writes through `ThemeProvider`.
  WebUI has no theme settings entry, dialog or switching controls in either its
  wide sidebar or mobile navigation. `useRemoteTheme` only loads the Host theme
  through authenticated `GET /api/v1/theme` and consumes `theme_settings_changed`
  on its existing socket, including applied custom CSS. Refresh on initialization,
  reconnect/resync and foreground.
- Apply only newer Host revisions so HTTP replies and event replay cannot
  restore an older theme. Theme writes are field patches, serialized per
  client, and apply only after persistence succeeds; failures show a localized
  toast and WebUI authorization failures use its existing re-pairing flow. Saved
  theme selection patches family/CSS/name atomically. Clean editor drafts follow
  incoming CSS/name changes without overwriting unsaved drafts. `system` resolves
  against each device's system preference.
- `pilo.theme.v1` and the legacy mode/family keys are startup caches only.
  Desktop seeds an absent DB row from its legacy browser preferences once;
  WebUI never seeds the Host theme from browser storage or exposes theme writes.
  See
  [Shared Theme Settings](../backend/database-guidelines.md#shared-theme-settings).

## Font Preferences

- Font preferences are device-local (`pilo.preferences.v1` in `localStorage`),
  not synchronized between desktop and WebUI. UI, reading, code and terminal
  fonts/sizes are independent. Defaults are UI 15px, reading 16px, code 14px and
  terminal 14px; accepted sizes are finite numbers within the ranges in
  `src/lib/font-settings.ts`.
- UI scaling uses a fixed 14px Tailwind `text-sm` baseline, not the configurable
  default size. Reading/code/terminal sizes stay independent of rem geometry.
  Legacy `pageFontSize` / `conversationFontSize` migrate to reading size;
  a missing reading font family falls back to the stored page font family.
- `resetFontFamilies()` resets only the four families; `resetFontSizes()` resets
  only the four sizes. Neither action changes unrelated preferences.
- `src/main.tsx` marks the HTML root with `data-remote-webui` before WebUI boot,
  including pairing, error pages and portaled menus. At widths up to 1023px,
  mobile UI text uses the former default scale (`text-sm` 16px with the normal
  browser root size), without scaling rem geometry. UI/reading fonts use the
  fixed Inter/system sans-serif stack; composer text has a 16px iOS focus-zoom
  floor. Desktop preferences must not be overridden by these mobile rules.
- Shared composer sizing uses actual line height, a 12-line cap and remaining
  chat-panel space after surrounding controls/safe-area padding. Observe both
  the panel and composer region; ignore region changes caused only by textarea
  height, coalesce resize callbacks in animation frames and clean up on unmount.

## Desktop Developer Mode

### 1. Scope / Trigger

Desktop Preferences exposes a device-local opt-in for inspecting the current
main/session window. WebUI keeps browser-native tools and has no switch.

### 2. Signatures

- `PiloPreferences.developerMode: boolean`, `setDeveloperMode(value: boolean)`.
- `useDeveloperTools(enabled: boolean, keyboardShortcuts: KeyboardShortcutMap)`
  installs desktop-only key handling.
- Tauri `desktop_open_devtools(window: WebviewWindow) -> Result<(), String>`
  opens the invoking window's tools; there is no remote HTTP endpoint.

### 3. Contracts

The existing `pilo.preferences.v1` entry stores the flag. Only literal `true`
enables it; missing/invalid values default to false. Tauri's inspector shortcut
is captured before its built-in handler. F12 is captured only when enabled,
not assigned to an application command, and not being recorded by a
`[data-shortcut-recording="true"]` editor. Existing F12 bindings and recording
keep their normal event propagation. Captured repeat/composition events never
open tools. This is a UI opt-in, not an authorization boundary.

### 4. Validation & Error Matrix

IPC rejection logs the detail and shows `settings.openDeveloperToolsFailed`.
WebUI installs no listener and must retain native browser shortcuts.

### 5. Good / Base / Bad Cases

Good: enabled F12 opens the invoking desktop window. Base: old preferences load
with the feature off. Bad: enabling the Cargo feature alone exposes native
shortcuts irrespective of the switch.

### 6. Tests Required

When authorized, verify off/on/off, persistence after restart, main and session
windows, release builds and unchanged WebUI shortcuts. Cover an existing F12
application binding with developer mode off and on, and F12 recording while
mode is enabled. Tests/builds and actual Windows interaction have not been run
for this feature.

### 7. Wrong vs Correct

Wrong: rely on a frontend F12 handler alone after enabling release DevTools.
Correct: enable Tauri's `devtools` Cargo feature, disable native WebView2
inspector entry points with `devtools(false)` in both Windows window-creation
paths, and use the gated IPC call. WebView2's `OpenDevToolsWindow` still works
when native inspector shortcuts/context-menu entries are disabled. Do not
promise closing/toggling: Wry's Windows `close_devtools` is a no-op.

Known unresolved gap: macOS/Linux still enable native inspector entry points
regardless of the preference. Do not copy the Windows `devtools(false)` fix
blindly: WebKitGTK requires developer extras to open its inspector at all.
A native platform bridge is needed to control these settings without removing
normal editing context menus; macOS bridging must first resolve the project's
restriction on `unsafe`.

## Forbidden

- Introducing Zustand/TanStack Query for a new feature without an explicit
  project decision.
- Duplicating server state into a global store as a cache.
- Persisting derived state; recompute from source.
