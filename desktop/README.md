# Pilo desktop (nsh)

## Native runtime

`new Pilo()` uses the same macOS data directory as Tauri: the bundle ID
`app.hsingjui.pilo` under `~/Library/Application Support` (with `.dev` for
debug builds). Tests can pass a separate absolute path. Call `bootstrap()`
for saved projects, live chat snapshots, Host preferences and `eventSequence`.
The sequence is captured before reading the snapshot state; it is not a
transcript watermark. Await `shutdown()` before quitting the app.

Each `Pilo` subscribes to runtime events before its first bootstrap. Use one
`nextEvents(max)` poll at a time with a positive safe-integer batch size.
It returns `{ type: "events", events }` with ordered, sequenced runtime envelopes,
`{ type: "gap", firstMissed, lastMissed }` with the inclusive range dropped on
overflow, or `{ type: "closed" }` when the runtime shuts down. The queue is
bounded to 2,048 events or 16 MiB of serialized envelopes, whichever is reached
first. On a gap, bootstrap again and keep polling the same `Pilo` instance.

Use `loadPreferences()` and `savePreferences(patch)` to read or update the
existing Host preferences. Both return the current revision and complete
values; writes patch only the supplied fields.

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
`deleteSession(projectId, sessionPath)` removes an indexed session and
returns `{ method: "trash" | "unlink" }`.

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
SSH/WSL cuts are always truncated; those connections need the settled-history
reader instead. The bootstrap sequence is not a substitute for a transcript cut.
`sendChatCommand(sessionKey, command)` forwards a Pi RPC command object to
the running session. The promise resolves once the command is sent; consume
its response and any turn events via `nextEvents()`.
`shutdown()` closes the event stream and tears down running Pi processes,
including active turns; it does not wait for a reply to finish.

`loadSessionReadStates()` reads the saved read revisions across projects.
Call `markSessionRead(projectId, sessionPath, revision)` with the positive
safe-integer revision the client observed. It returns the resulting read
state without moving it backward or past the latest completed revision.

Build the local development server with `cargo build -p pilo-server` from
the repo root, or set `PILO_SERVER_BINARY` to an absolute path. Development
WebUI assets come from `dist/`; a packaged app will stage them under
`Contents/Resources/webui` and the server under `Contents/Resources/runtime`.

## Built-in themes

From the repository root, run `pnpm desktop:generate:themes` after editing
`src/styles/lody-theme.css` or `src/styles/claude-theme.css`. The checked-in
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
`lucide-react` icon imports in `src/`. Add `--check` to detect stale output.
The generated `app/lucide-icons.json` uses the original export names, including
aliases, without bundling React or Lucide.

Each icon has its original square viewbox `size` and ordered `paths`.
Scale the Canvas context from that viewbox, construct `new Path2D(d)` for each
path, fill entries marked `fill: true`, and stroke every path. Lucide defaults
to a 2-unit stroke and round caps/joins. The source data is covered by
`app/Lucide-LICENSE`.

## Custom themes

A custom theme is a token table shared by the desktop and the WebUI, checked by
`src/lib/theme-tokens.ts` before it is applied:

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

## Native images

nsh 0.6.0 returns Rust `Vec<u8>` as `Uint8Array`, but `Image.src` does
not take the array directly. Pass a `URL.createObjectURL(new Blob([bytes],
{ type: mimeType }))` URL and revoke it when no longer needed. A native
absolute local file path also works as `Image.src`.
