# Pilo desktop (nsh)

## Native runtime

`new Pilo()` uses the Tauri data directory: `app.hsingjui.pilo` under
`%APPDATA%` on Windows or `~/Library/Application Support` on macOS, with
`.dev` appended for debug builds. Tests can pass a separate absolute path.
Call `bootstrap()` for saved projects, live chat snapshots, Host preferences
and `eventSequence`. The sequence is captured before reading the snapshot
state; it is not a transcript watermark. Await `shutdown()` before quitting
the app.

Each `Pilo` subscribes to runtime events before its first bootstrap. Use one
`nextEvents(max)` poll at a time with a positive safe-integer batch size.
It returns `{ type: "events", events }` with ordered, sequenced runtime envelopes,
`{ type: "gap", firstMissed, lastMissed }` with the inclusive range dropped on
overflow, or `{ type: "closed" }` when the runtime shuts down. The queue is
bounded to 2,048 events or 16 MiB of serialized envelopes, whichever is reached
first. On a gap, bootstrap again and keep polling the same `Pilo` instance.

Use `loadPreferences()` and `savePreferences(patch, initial?)` to read or update the
existing Host preferences. Both return the current revision and complete
values; ordinary writes patch only the supplied fields. At startup, nsh shows
the macOS system locale and calls `savePreferences({ locale }, true)` before
loading app state. The Host only fills in missing values on this one-time
initialization; an explicitly saved locale wins.

nsh cannot read the Tauri WebView's local storage. An nsh-first launch sets
the same Host migration flag as Tauri, so legacy preferences still living
only in the WebView are not imported, even by a later Tauri launch. The
[parity checklist](../.trellis/tasks/11-19-nsh-desktop-migration/feature-parity.md#webview-localstorage-清单)
does not copy those preference caches. If an older installation has only
the WebView caches, let Tauri import them into the Host before switching to
nsh.

Use `loadThemeSettings()` and `saveThemeSettings(update)` for saved Host
appearance. Both return the complete Host settings, including
`themeCustomTokens` and the read-only `themeCustomConversion` report.
Token-only saves keep the legacy CSS.

`listProjects()` refreshes the saved project catalog without loading live chat
snapshots. `listSessions(projectId)` uses the same session-index reconciliation
as the Tauri client and returns saved sessions, not live chat state.
`searchSessions(projectId, query, limit?)` searches saved message text and
returns matches with the session path and ID, role, snippet, and timestamp.
`generateSessionTitle(projectId, message)` uses the connection's naming
model and returns a title, or `null` if no title is available.
`searchProjectFiles(projectId, query)` returns the project-relative file
paths matching a query, for composer `@` mentions.
`uploadChatFile(projectId, name, data)` stores a composer attachment inside
the project and returns the path an `@` mention references;
`removeChatFile(projectId, path)` removes one.
`deleteSession(projectId, sessionPath)` removes an indexed session and
returns `{ method: "trash" | "unlink" }`.

`listConnections()` returns Local plus every WSL and SSH connection.
`addProject(connectionId, path)` adds a project to the catalog, like the
Tauri client's `addProject`. `readConnectionDir(connectionId, path?)`
lists one directory level on the connection (`/` when omitted), for the
remote folder browser. `pickLocalProjectDirectory()` opens the host's
native folder picker and resolves with the chosen path, or `null` when
cancelled; it is host-only like the Tauri dialog's local browse.

`loadHistory(projectId, sessionPath, options?)` reads settled Pi history
without starting a chat. It returns `{ history, fingerprint }` and uses the
same reader and defaults as the Tauri client. Options are `startMessage`
(zero-based; defaults to the tail), `messageLimit` (default 256, clamped to
1–256), `includeMessageIndex` (default true), and the optional fingerprint
from a previous read. A missing session is rejected. Use this reader for
sessions without running Pi or to recover settled history after an unsafe turn; the
result has no transcript event sequence.

`loadConnectionModels(connectionId)` queries Pi's current user-level catalog
for the connection, not a union of project caches.
`loadModels(projectId)` returns the Host's saved project catalog (models,
commands, defaults and refresh timestamp), or `null` if none is cached.
It does not launch Pi or refresh the cache.

`loadModelScope(projectId)` reads the Host's project model scope and returns
`{ projectId, models, updatedAtMs }`. Each model is
`{ provider, modelId, thinkingLevel, isDefault }`. A missing scope returns
`models: null` (inherit Pi) and `updatedAtMs: 0`; `models: []` means an
explicit empty scope. An unknown project is rejected.
`saveModelScope(projectId, models)` replaces the scope with the supplied
ordered array (`[]` clears all members), or restores Pi inheritance with
`null`. `thinkingLevel` is null or one of `off`, `minimal`, `low`,
`medium`, `high`, `xhigh`, and `max`; omitted `isDefault` is false,
and at most one member may be the default. A successful save returns the
updated scope with a larger `updatedAtMs` and publishes
`project_model_scope_changed` with `projectId` and `scope`. Neither call
launches Pi.

`loadCacheKeepAliveSettings(connectionId)` returns the connection's saved
model policies (ordered by provider and model ID), or `[]` if it has none.
Each policy has `connectionId`, `provider`, `modelId`, `enabled`,
`cacheTtlSeconds`, `idleKeepAliveSeconds`, and `updatedAtMs`. An unknown
connection is rejected. Loading does not launch Pi.
`saveCacheKeepAliveSettings(settings)` upserts one policy by connection,
provider, and model ID. TTL must be 10–86400 seconds and idle duration
60–86400 seconds. The Host assigns a monotonic `updatedAtMs` for that policy,
returns the saved policy, and publishes `cache_keep_alive_settings_changed`
with `settings`. Saving may reconfigure already-running eligible Pi sessions
on that connection, but does not launch Pi.

`loadNextPromptSettings(connectionId)` returns
`{ connectionId, enabled, model, updatedAtMs }`, where `model` is
`{ provider, id }` or `null` (follow the chat model). With no saved row,
it returns `enabled: false`, `model: null`, and `updatedAtMs: 0`.
An unknown connection is rejected. Loading does not contact Pi.
`saveNextPromptSettings(connectionId, enabled, model)` replaces the saved
settings and returns the updated snapshot with a larger `updatedAtMs`.
Pass the selected model again to retain it when disabling prediction, or
pass `null` to follow the chat model. A successful save publishes
`next_prompt_settings_changed` with `settings`. Saving does not contact Pi.
`requestNextPrompt({ sessionKey, sessionId, requestId, generation, revision, cancel? })`
returns `Promise<void>` once the command is sent to the existing Pi process;
it never starts a chat. Use the running chat's generation, Pi's session ID,
and the settings' `updatedAtMs` as the revision. Predictions require an idle,
ready chat and current enabled settings. Set `cancel: true` with the same
request identity to cancel, even if the settings have since changed.
Results arrive through `nextEvents` as `extension_ui_request` events with
`method: "setWidget"`, `widgetKey: "pilo.next-prompt.v1"`, and one JSON result
in `widgetLines`; match the session, generation, request ID, and revision.

`loadPromptEnhancementSettings(connectionId)` returns
`{ connectionId, enabled, model, updatedAtMs }`, where `model` is
`{ provider, id }` or `null` (follow the chat model). With no saved row,
it returns `enabled: false`, `model: null`, and `updatedAtMs: 0`.
An unknown connection is rejected. Loading does not contact Pi.

`savePromptEnhancementSettings(connectionId, enabled, model)` replaces the
saved settings and returns the updated snapshot with a larger `updatedAtMs`.
Pass the selected model again to retain it when disabling enhancement, or
pass `null` to follow the chat model. A successful save publishes
`prompt_enhancement_settings_changed` with `settings`. Saving does not contact Pi.

`enhancePrompt(projectId, draft, model)` returns the rewritten draft as a
string. The project's connection must enable prompt enhancement. The saved
model takes precedence over the supplied chat model (`{ provider, id }`);
pass `null` to let Pi use its default if neither model is specified. The
Host runs a throwaway Pi process with no session or resources, so the
rewrite does not enter the transcript or consume the chat queue. The Host
strips wrapping fences and quotes. Empty drafts, disabled settings,
unavailable models, empty replies, and Pi failures reject the call.

Use `readProjectImage(projectId, path)` for a project-relative image and
`readHistoryImage(projectId, sessionPath, imageId, fingerprint?)` for a
transcript attachment. Both return `Uint8Array` bytes; nsh `Image` accepts
a Blob URL made from those bytes. The optional fingerprint carries
`fileSize` and the exact `fileMtimeNs` string.

Use `startChat({ projectId, sessionKey, sessionPath?, noSession?, builtinExtensions? })`
to start or resume Pi and get its ready process snapshot. Omit `sessionPath`
for a new session; `noSession` defaults to false. The optional client-selected
built-in extension is `{ id: "model-catalog" }`.
The bridge does not accept per-launch inline Pi extension sources. Host-managed
built-ins and Pi's normal extension discovery do not use that argument.
`stopChat(sessionKey, reason?)` stops the Pi process for that key and is a
no-op if the session is not running.
`chatState(sessionKey)` returns the live runtime metadata and Pi process
snapshot for that key, or `null` if no state is available. It does not return
transcript text.
`chatTranscriptSnapshot(sessionKey: string, window?): Promise<unknown>`
captures an existing chat's transcript without starting Pi; it rejects unknown
or closing sessions. The optional window is
`{ startMessage?: number, messageLimit?: number, includeMessageIndex?: boolean }`.
Omit `messageLimit` for all messages. When supplied, the reader clamps it to
1–256, defaults to the tail when `startMessage` is omitted, and includes the
message index on request. The result has
`{ eventSequence, sessionKey, generation, history, live }`. `history` is the
existing history response, including its fingerprint; `live` is
`{ type: "idle" }`, `{ type: "active", events }`, or `{ type: "truncated" }`.

Subscribe before requesting the snapshot and keep polling the same stream.
For an idle cut, history is settled and there are no live events. For an active
cut, history ends at the start-of-turn boundary and `live.events` holds the
ordered runtime event payloads captured through the cut. Replace that session's
transcript with history, apply all `live.events` if active, then replay stream
events for the same session and generation strictly above `eventSequence`.
Discard buffered events at or below that cut only for that transcript, not
other sessions or global state. A gap or generation change requires a fresh
cut. On `truncated`, do not apply its empty history or resume replay from that
cut; wait for Host activity to confirm the turn settled and then refetch.
Local, SSH and WSL use the same snapshot and event replay. SSH/WSL read the
pre-prompt history prefix on the running Pi process's pilo-server connection.
If that prefix is unavailable or cannot be verified, the active snapshot is
truncated. The bootstrap sequence is not a substitute for a transcript cut.
`sendChatCommand(sessionKey, command)` forwards a Pi RPC command object to
the running session. The promise resolves once the command is sent; consume
its response and any turn events via `nextEvents()`.
`shutdown()` closes the event stream and tears down running Pi processes,
including active turns; it does not wait for a reply to finish.

`loadSessionReadStates()` reads the saved read revisions across projects.
Call `markSessionRead(projectId, sessionPath, revision)` with the positive
safe-integer revision the client observed. It returns the resulting read
state without moving it backward or past the latest completed revision.
The app marks the open session read while it is the active app. macOS tests
run their apps in the background, so that case runs there only with
`nsh test --target macos --foreground tests/read-open-session.test.ts` and
is passed over in the plain macOS run.

Build the local development server with `cargo build -p pilo-server` from
the repo root. The app prefers `target/debug/pilo-server` and falls back to
`target/<arch>-apple-darwin/debug/pilo-server`; `PILO_SERVER_BINARY` can override
both with an absolute path. Development WebUI assets come from the same repo
root's `dist/`, even when nsh generates its own manifest. A packaged app will
stage WebUI assets under `Contents/Resources/webui` and the server under
`Contents/Resources/runtime`.

## Chat transcripts

`ChatTranscriptStore` (`state/chat-transcript-store.ts`) holds the transcript
of the open chat. Opening a chat starts nothing.

- With Pi running, it reads `chatTranscriptSnapshot` and applies the chat's
  later events, so a turn streams. A gap, a reconnect, Pi reattachment, or a
  newer Pi process takes a fresh snapshot.
- Without a snapshot, it shows the session file's settled history from
  `loadHistory`: no Pi, a stopped or failed process, or a snapshot that is
  truncated with no turn running or again after the turn settled. A truncated
  snapshot of a running turn shows nothing new until that turn has settled.
- A chat on settled history tries a snapshot again when Pi comes up and once
  when each turn starts, so a chat can go back to streaming.

Either read loads the session's last 80 messages and its message index, as
the WebUI's first read does, so a long session is never replayed whole. The
state has two parts:

- `conversation`: the loaded messages and the turn in progress.
- `historyPrefix`: every saved message before them, oldest first. One that
  is not loaded is a placeholder built from the index by the Tauri app's
  history window store: `historyPlaceholder` is set, `text` is a preview,
  and the id is the one the message has once loaded. This array does not
  change while a turn streams.

`messages()` on the store joins the two for a list that wants one array. It
copies the prefix whenever either part changed, so reading it for each
streamed event costs about 0.14 ms in a 10,000-message session, against
0.006 ms for the event itself.

`loadRange(startIndex, endIndex)` loads the placeholders among those
messages of `messages()`, the range a list shows, as the WebUI's
`requestHistoryRange` does: 16 messages around the range, in pages of 48
read with `loadHistory`. The range last asked for stays loaded and is loaded
again after each read of the chat. The window store keeps at most 200 loaded
messages: beyond that, the least recently loaded outside the range go back
to placeholders.

The invariant a list can rely on: message `i` of the session is always at
index `i` of `messages()`. A message is loaded in the place of its
placeholder and goes back to a placeholder in the same place; nothing is
inserted or removed before the conversation's messages; and a read that
starts its window elsewhere still has the same message at each index.

A page is used only if it comes from the file the chat was read from, by its
fingerprint, as in the WebUI. Otherwise the chat is read again and the range
loaded from that read: once for each change of the file, however often a
range is asked for.

Known gap: while a turn runs, older messages stay previews and load by
themselves when the turn ends, unless the chat's older messages were already
loaded before the turn. A snapshot during a turn is of the file as the turn
found it, and the runtime answers a page of that file only while it still
holds its history. From `load_history` in the runtime's
`session_history/reader.rs` it does not in two cases, which were not run: a
chat opened with Pi already running and scrolled up for the first time
during a turn, and a chat read again (a gap in the event stream, switching
back to it) during its second or a later turn.

## Built-in themes

From the repository root, run `pnpm desktop:generate:themes` after editing
`web/styles/lody-theme.css` or `web/styles/claude-theme.css`. The checked-in
`theme.json` (Lody) and `claude-theme.json` are complete themes; use
`pnpm desktop:generate:themes --check` to detect stale output.

- `cssVars` contains the tokens understood by nsh 0.6.0: colors, shared
  numbers/lengths and font families. Pass `{ cssVars }` to `setTheme`.
  Absolute `calc()`/ `max()` lengths are reduced at 16 points per rem.
  There is no generic `radius` in the source themes: use the named Pilo radius
  tokens, or leave the built-in nsh radius at its default.
- `styleVars` retains resolved source CSS values that `token()` cannot expose,
  including shadows, motion, shorthand values and layout-dependent math.
  Use the relevant theme/appearance's values with explicit component styles
  where supported; do not pass this map to the native token API.

## Icons

Run `pnpm desktop:generate:icons` to refresh the Canvas data from the named
`lucide-react` icon imports in `web/` plus the desktop-only names listed in
`app/lucide-icon-names.json`. Add `--check` to detect stale output.
The generated `app/lucide-icons.json` uses the original export names, including
aliases, without bundling React or Lucide.

Each icon has its original square viewbox `size` and ordered `paths`.
Scale the Canvas context from that viewbox, construct `new Path2D(d)` for each
path, fill entries marked `fill: true`, and stroke every path. Lucide defaults
to a 2-unit stroke and round caps/joins. The source data is covered by
`app/Lucide-LICENSE`.

## Custom themes

The nsh settings only offer the built-in themes (Lody, Claude); they no longer
create, edit or delete custom themes. A custom theme already saved on the Host
(for example from the Tauri app) still renders as described below.

A custom theme is a token table shared by the desktop and the WebUI, checked by
`shared/theme-tokens.ts` before it is applied:

```json
{
	"theme": {
		"pilo-bubble-radius": "1.5rem",
		"font-mono": "'Fira Code', monospace"
	},
	"light": { "primary": "#c2512e" },
	"dark": { "primary": "hsl(225 7.1% 11%)" }
}
```

- `theme` applies to both appearances, `light` to light and to dark where
  `dark` does not set the token, `dark` to dark only. Only color tokens may be
  set per appearance, and a token set in `theme` may not appear in `light` or
  `dark`.
- Token names are the built-in theme's `cssVars` names without `--`
  (`createThemeTokenCatalog`); the kind of each comes from its built-in value.
  Values are strings: colors in hex, `rgb()`/`rgba()`, `hsl()`/`hsla()` or
  `transparent`, opaque only for the non-`pilo-` colors (`opaque-color`: the
  WebUI holds them as HSL channels used as `hsl(var(--x) / a)`, so they cannot
  carry their own alpha; `--pilo-*` colors are full colors and may); lengths in non-negative `px` or `rem`; plain numbers; font
  family lists (nsh uses the first family, the WebUI the whole list).
- `validateCustomThemeTokens` rejects the whole table and lists every problem
  if anything is wrong, so the current theme stays. Pass
  `{ cssVars: resolveCustomTheme(builtIn.cssVars, tokens) }` to `setTheme`;
  `desktop/tests/custom-theme.test.ts` checks nsh reads every accepted form
  exactly as `parseThemeColor`/`parseThemeLength` do.

## Saved fonts

`followSavedAppearance` (`app/appearance.ts`) applies the saved page and code
fonts to `font-sans` and `font-mono`. Lody also uses the page font for
`font-display`; Claude and custom themes keep their own display font when set.
Until preferences load, the page font falls back to Noto Sans SC on Windows
and the system UI font elsewhere, and the code font to system monospace.

- `codeFontSize` still sets `pilo-code-font-size`, and the composer still uses
  `readingFontSize`.
- `uiFontSize` is not applied. The Tauri app scales every size by it through
  the root font size; nsh 0.6.0 has no text size an app can set (`fontScale`
  is read-only).

## Native images

nsh 0.6.0 returns Rust `Vec<u8>` as `Uint8Array`, but `Image.src` does
not take the array directly. Pass a `URL.createObjectURL(new Blob([bytes],
{ type: mimeType }))` URL and revoke it when no longer needed. A native
absolute local file path also works as `Image.src`.
