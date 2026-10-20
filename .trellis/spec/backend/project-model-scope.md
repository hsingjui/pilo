# Project Model Scope

## 1. Scope / Trigger

Apply this contract when changing model preferences, model pickers, scoped cycling,
`PiloClient`, or project preference events. Scope belongs to Pilo, not Pi settings
or session JSONL. Both transports use the Host's database.

## 2. Signatures

- Tauri: `project_model_scope_get(projectId) -> ProjectModelScope` and
  `project_model_scope_set(projectId, models) -> ProjectModelScope`.
- Authenticated HTTP: `GET /api/v1/models/scope?projectId=...` and
  `POST /api/v1/models/scope` with `{ projectId, models }`.
- `PiloClient.loadModelScope(projectId)` / `saveModelScope(projectId, models)`.
- Storage: `project_model_scopes(project_id TEXT PRIMARY KEY REFERENCES
  projects(id) ON DELETE CASCADE, models_json TEXT NULL, updated_at_ms INTEGER NOT NULL)`.
- Response: `{ projectId, models: ProjectScopedModel[] | null, updatedAtMs }`.
  Each member is `{ provider, modelId, thinkingLevel }`; thinkingLevel is null or
  `off | minimal | low | medium | high | xhigh | max`.
- Event: `{ type: "project_model_scope_changed", projectId, scope }`. No
  sessionKey or process generation; publish only after a successful write.

## 3. Contracts

- No row / `models: null` inherits Pi. `models: []` is a custom empty Scope.
  An array completely replaces the inherited list; never union the two.
- New-chat startup precedence on Desktop and WebUI is explicit user selection,
  then the first stored member of a custom project Scope, then Pi's own default.
  `getProjectScopeDefaultModel` in `src/lib/pi-model-selection.ts` resolves that
  member by provider + model ID against the available catalog. Missing/inherited/
  empty Scope, or an unavailable first member, leaves the model to Pi; never
  silently select a later member. Apply the member's thinking override or its
  model profile default, unless the user explicitly picked another level.
- Drafts store only explicit selections; derive project defaults from the current
  Scope/catalog so late responses and menu reloads cannot overwrite user intent.
  Without an explicit model selection, wait for Scope loading and (for a custom
  nonempty Scope) the model catalog before allowing startup. Preference/catalog
  failures remain visible, not an implicit fallback to unknown defaults. Scope
  changes never reapply startup defaults to an already identified/live session.
- One atomic upsert replaces all members. `updatedAtMs` is monotonically
  increasing per project (`MAX(now, previous + 1)`), even for restoring null.
  Consumers reject lower revisions and stale project/transport requests.
- Model identity is provider plus model ID. Preserve stored order and explicit
  thinking overrides. Catalog absence never deletes or rejects a stored member.
- `project_model_cache` stores the Pi model and command catalog, including
  scopeOrder, scopeThinkingLevel and a refresh timestamp for ordering, not TTL.
  Complete caches are reused until explicit refresh; missing/incomplete caches
  are probed once on demand (see Project Catalog and Slash Commands below).
- `getProjectScopeModels` in `src/lib/pi-model-selection.ts` owns the effective
  list. Inheritance orders the Host catalog first, then intersects live available
  identities. Intersecting first could accidentally turn an unavailable Pi Scope
  into the all-model fallback. Custom empty lists never take that fallback.
- Inherited Scope requires a loaded catalog with explicit scopeOrder and
  scopeThinkingLevel on every model (null is resolved, undefined is unknown).
  Legacy/bare catalogs are unresolved, not an all-model default. A custom Scope
  only requires a successfully loaded available-model list; it does not depend
  on Pi's default Scope metadata. Empty loaded catalogs differ from no catalog.
- Desktop has two independent configuration owners: `NewChatLanding` for unsent
  drafts (including temporary drafts) and `useChatSessionConfig` for opened
  sessions. Both must load/subscribe to project preferences, pass ModelScopeControls
  into ChatComposer and use the effective Scope for scoped shortcuts. Updating
  ChatPage alone does not cover the landing composer. The lazy loading fallback
  has no configuration controller and sets canEditScope=false.
- Desktop keeps the original catalog in React state, updated alongside the all
  models list on hydration, subscription and refresh. Derive Scope from that
  same snapshot, not a separate global-cache read during render. Guard hydration
  and refresh results against project/session changes. Web uses this same cached
  catalog for availability; live RPC refreshes only session state, thinking levels
  and statistics, not the model or command directory.
- Desktop scoped cycling selects in Pilo and uses existing set_model /
  set_thinking_level; Pi owns thinking-level clamping. The all-model shortcut
  keeps its original list/control flow. A singleton already selected is inert.
- Desktop subscriptions are project-global. Web handles preference events before
  activeSessionKey filtering; reconnect/resync and menu opening reload settings.
- Shared `ChatModelPicker` maintains an independent draft, initialized from the
  effective inherited list or complete custom members (including unavailable
  ones). Events update formal preferences, never the open draft. Apply is one
  save; cancel/close discards; unchanged drafts do not create overrides. Failed
  saves retain the draft; duplicate submissions are blocked.
- `ModelScopeControls.projectId` identifies the picker before formal preferences
  arrive. Key overlays by that stable project identity and layout capability,
  never by `scope?.projectId`: the first preference response must not remount
  the picker and reset its view, query or focus.
- All and Scope share loading/error presentation. Every actual catalog refresh,
  including incomplete-cache refreshes, reports loading; keep valid existing rows
  visible. A missing-metadata message is only appropriate after loading ends.
  Before a refresh disables its button, focus the search input so Radix does
  not dismiss the submenu through focus-outside handling. Refresh updates data
  in place, without closing the overlay or discarding an editor draft.
- Desktop retains the nested Model / Reasoning DropdownMenu, including the
  original reasoning submenu. Only the model submenu hosts the shared picker
  (`compact` single-line rows). Its input/Command owns typing and arrow keys;
  stop bubbling before Radix menu typeahead and keep Tab inside the picker.
  The root trigger keeps menu semantics; the input-bearing model popup has
  dialog semantics. Do not replace desktop menus with the flat touch panel.
- `canEditScope` controls management UI: desktop app and wide WebUI allow it;
  narrow WebUI does not. Touch/hover detection only selects the overlay type,
  not whether management is available. Touch sheets use viewport height and
  `--remote-keyboard-bottom` to stay above the keyboard, plus safe-area padding.
- Saving preferences must not start, stop, restart or reconfigure Pi. Never write
  Pi settings.json, forward a Scope configuration RPC or spawn a WebUI probe.

## 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Project missing | `Project '<id>' was not found`; preference routes return 400 |
| Blank provider/model ID | `model scope provider and model id cannot be empty` |
| Duplicate provider + model ID | `model scope contains duplicate model identities` |
| Invalid thinking level | Serde/Tauri or JSON extraction rejects the request |
| Valid but unavailable member | Saved unchanged; excluded from effective selection/cycling |
| SQLite/read/write failure | Error propagates; failed writes publish no event |
| Scope read fails | Display error; do not reinterpret as inheritance |
| Older event/read/save response | Does not replace newer formal preferences |
| Save fails | Formal preferences unchanged, draft remains editable |
| Project deleted | Foreign key cascade removes preferences |

## 5. Good / Base / Bad Cases

- Base: existing project has no row, uses Pi's resolved Scope, creates no override
  merely by opening or closing the editor.
- Good: inherited five members remain checked; multiple edits stay local until
  Apply; Web and desktop then use the same saved complete list.
- Good: custom unavailable members remain in the editor and can be removed;
  searching or selecting visible results never silently drops them.
- Bad: custom empty Scope must not cycle all models. Restore inheritance is a
  separate explicit null save, not the Clear selection action.
- Bad: a delayed read, project switch or another client save must not overwrite
  a newer preference or an unsubmitted local draft.

## 6. Tests Required

Add/update/run tests only with explicit user authorization. Assertion points:

- Storage: null/empty/nonempty round trips; duplicate/blank/invalid levels;
  unavailable retention; project cascade; increasing same-millisecond revisions.
- Selection: identity collisions across providers; inherited order/thinking;
  custom replacement/empty; unavailable intersection before fallback; singleton;
  custom Scope first-member new-chat default with thinking override/profile
  fallback; absent/inherited/empty/unavailable-first fallback to Pi; explicit
  user selection wins on Desktop and WebUI, including late Scope responses.
- UI: unchanged/cancelled drafts; batch actions; failed save/retry; incoming
  events during editing; narrow management hidden; keyboard search/navigation;
  delayed first preference response preserves Scope view/query/focus; refreshing
  either view keeps the overlay open and retains an existing draft. Check the
  landing page before the first message separately from opened/historical
  sessions: each enabled picker must receive a populated Scope controller.
- Catalog: incomplete-cache refresh shows loading in both views; inherited bare
  metadata stays unresolved; custom Scope works with bare availability; empty
  loaded catalogs remain distinct from missing catalogs; old-project hydration
  cannot replace the current project's snapshot.
- Existing `tests/unit/chat-composer-run-config.test.ts` keeps asserting the genuine
  root DropdownMenu trigger's `aria-haspopup="menu"`, Slot prop forwarding,
  disabled state and accessible name. No assertion change is needed merely
  because the model submenu now contains search/Scope controls.
- Cross-transport: event before session filtering, stale responses, project
  switching and reconnect; no Pi process/config mutation while editing.

## 7. Wrong vs Correct

```ts
// Wrong: an explicit empty override falls back to the full catalog.
const effective = custom.length ? custom : getPiQuickCycleModels(catalog);

// Correct: absence and empty are different; use the shared projection.
const effective = getProjectScopeModels(available, preference, hostCatalog);
```

```ts
// Wrong: session filtering drops project-global preferences.
if (event.sessionKey !== activeKey) return;

// Correct: consume Scope changes first; they have no process generation.
if (event.type === "project_model_scope_changed") {
  scopeController.handleEvent(event);
  return;
}
if (event.sessionKey !== activeKey) return;
```

## Project Catalog and Slash Commands

### 1. Scope / Trigger

Use when changing model/command discovery, cache freshness, composer suggestions
or catalog refresh in Desktop and WebUI. A session having run previously does
not mean its Pi process is still running when reopened.

### 2. Signatures

- `ProjectPiModels` / `ProjectModelCache` adds `commands: PiCommand[] | null`.
- `project_model_cache.commands_json TEXT NULL`; additive migration preserves
  old caches. `null` means unknown; `[]` means successfully discovered empty.
- `project_model_cache_set` accepts optional commands alongside model fields.
- Authenticated `GET /api/v1/models?projectId=...` reads the shared snapshot;
  `POST /api/v1/models` saves it and assigns the Host timestamp.
- `WebPiloClient.loadModels(projectId, force = false)` reads cache first and
  invokes `refreshProjectPiModels(projectId, transport)` only when forced or
  incomplete. Desktop uses the same refresh function with the Tauri transport.

### 3. Contracts

- One throwaway `noSession` probe reads models and `get_commands` from the same
  project/Pi environment, preserving the existing extension/RPC model fallback.
  Remove the probe-only `pilo_model_catalog` command before caching.
- No catalog TTL, hourly polling, per-draft forced refresh, separate command
  probe, or per-session command reload. Configuration changes need manual refresh.
- Desktop landing/opened-session composers and WebUI derive suggestions and
  extension-name routing from the same project catalog. Passive completion must
  not start a history session. Executing a known extension still ensures Pi.
- Web probes reuse the existing event socket, register RPC waiters before send,
  scope events to their probe session key, wait for the socket before startup,
  and release timers/listeners/processes on completion or failure.
- Command query failure retains previous commands (or null if unknown), never
  turns failure into an authoritative empty list, and does not fail model loading.
  Cache writes preserve known commands when an older client omits them.

### 4. Validation & Error Matrix

- Complete old timestamp: reuse without probing; timestamp orders updates only.
- Missing cache/command field/model profile metadata: probe on demand.
- Command failure: warning and retained commands; retry on a later request when
  the resulting cache is still incomplete. Persistence failure retains the
  in-memory snapshot and logs the error.
- Unknown project on HTTP save: 404. Non-catalog extension, sessionPath or missing
  noSession on a remote probe: 400. Authentication remains mandatory.

### 5. Good / Base / Bad Cases

- Good: reopen a stopped session on mobile; `/` shows extension and Skill entries
  from the cache, without sending a command to that stopped runtime.
- Base: restart/switch drafts with a complete cache; no new Pi probe.
- Bad: creating a separate landing command process or gating candidates on
  `runtimeReady` repeats the lifecycle mismatch behind issue #4.

### 6. Verification Required (When Authorized)

Cover NULL/empty command migration and round-trip, retained commands on query
failure, internal-command exclusion, old complete cache reuse, missing-cache
deduplication, manual refresh from both clients, RPC correlation and cleanup,
project switching during refresh, and no new indexed session after a Web probe.
Implemented assertions live in `tests/unit/pi-models.test.ts` (no age expiry, shared
probe deduplication, internal-command filtering, retained commands on failure and
probe cleanup/retry) and `runtime/storage.rs` (migration, NULL/empty commands,
older-client writes, stale-write rejection and cascade deletion).

WSL verification passed: `pnpm check`, `pnpm test:unit` (186 tests), `pnpm build`,
`cargo fmt --all --check`, `cargo check --offline`,
`cargo test --offline --workspace --lib` (134 tests), and
`cargo clippy --offline --all-targets --all-features -- -D warnings`.
Windows Desktop and actual mobile-browser end-to-end checks remain unverified.

### 7. Wrong vs Correct

Wrong: `if (!runtimeReady) return` before discovering composer commands, or
`loadModels(true)` on every draft mount. Correct: derive commands from the project
catalog and refresh only when missing/incomplete or explicitly requested.
