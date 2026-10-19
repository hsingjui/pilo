# Prompt Enhancement

## 1. Scope / Trigger

Apply when changing the composer's on-demand prompt rewrite, its per-Connection
settings, its desktop/WebUI entry points, or the shared one-shot Pi text runner.
Enhancement is not an Agent turn: it never touches a conversation, the chat
queue, or the primary model selection.

Owners: `runtime/prompt_enhancement.rs` (Host policy, settings and normalization),
`storage/prompt_enhancement.rs` (SQLite), `runtime/pi_oneshot.rs` (shared
throwaway runner), `runtime/commands/sessions/naming.rs` (session titles share
that runner). Desktop and WebUI share `usePromptEnhancementSettings`, the
settings fields and `ChatComposer`.

## 2. Signatures

- Tauri `prompt_enhancement_settings_get(connectionId) -> PromptEnhancementSettings`;
  `prompt_enhancement_settings_set(connectionId, enabled, model) -> PromptEnhancementSettings`;
  `prompt_enhance(projectId, draft, model) -> String`.
- Authenticated HTTP `GET /api/v1/prompt-enhancement/settings?connectionId=...`;
  `POST /api/v1/prompt-enhancement/settings` with `{ connectionId, enabled, model }`;
  `POST /api/v1/prompt-enhancement/enhance` with `{ projectId, draft, model }`,
  returning the rewritten text as a JSON string.
- `PiloClient.loadPromptEnhancementSettings(connectionId)`,
  `savePromptEnhancementSettings(connectionId, enabled, model)` and
  `enhancePrompt(projectId, draft, model)` use those same Host services.
- Settings: `{ connectionId, enabled, model: null | { provider, id }, updatedAtMs }`.
- SQLite `connection_prompt_enhancement_settings(connection_id TEXT PRIMARY KEY
  REFERENCES connections(id) ON DELETE CASCADE, enabled INTEGER NOT NULL DEFAULT 0
  CHECK(enabled IN (0,1)), provider TEXT NULL, model_id TEXT NULL,
  updated_at_ms INTEGER NOT NULL)`. A CHECK requires provider/model_id both null
  or both present.

## 3. Contracts

### Settings

- No row returns `enabled: false`, `model: null`, `updatedAtMs: 0`. Null means
  follow the chat model, so the composer sends its current selection.
- One UPSERT stores all fields and allocates `MAX(now, previous + 1)` as revision.
  Only a successful write broadcasts `{ type: "prompt_enhancement_settings_changed",
  settings }`, with no sessionKey, projectId or process generation.
- The settings key is the original project's Connection, not the execution
  Connection of an SSH workspace.
- Disabling in the UI preserves the selected model.

### Enhancement call

- The Host, never the client, decides whether the call is allowed: it re-reads
  the row for the project's Connection and rejects a disabled Connection.
- Model resolution: a configured model wins; otherwise the caller's chat
  selection; otherwise Pi's default. Both identities are trimmed and must be
  nonempty, otherwise the call is rejected before any process starts.
- One budget (`40s`) covers project resolution, process start, the prompt RPC,
  generation and the stop call. It must stay below the Remote WebUI Router's
  `45s` `TimeoutLayer`, otherwise the outer layer answers a generic `408` and the
  real reason never reaches the client. An elapsed budget drops the session so
  `ServerPiSession::Drop` still schedules cleanup.
- The rewrite runs on a throwaway Pi process: `no_session`, `disable_resources`,
  `thinking: "off"`, one single-line system prompt. It never joins a
  conversation, never consumes the chat queue and stays available while a turn
  is running or before a session exists.
- Drafts longer than 32,000 characters keep half of the head and half of the
  tail around an ellipsis; the head carries the task statement and the tail is
  what the user is actively writing.
- Reply normalization strips a Markdown fence only when it wraps the whole
  reply, and quotes only for a single wrapping pair. The first closing fence
  must be the final line: separate leading/trailing code blocks and inline
  backticks are not a wrapper. An empty result is an error.

### Frontend

- The composer shows the enhance control only when the Connection's settings are
  enabled; the default is disabled, so the control is absent rather than inert.
- While a rewrite is in flight the control is disabled, and the result is
  written back only if the draft (text, references and attachments) is unchanged,
  so a late reply never overwrites typing. Track the committed draft snapshot
  identity, including `attachmentScopeKey` and `historyKey`, not just equal text.
  Changing ownership, editing and reverting, or unmounting invalidates a request.
- Failures keep the draft and surface the Host detail; stale requests neither
  report errors nor move focus to a different draft.
- The settings entry mirrors prompt suggestions: one row per Connection, a
  model select defaulting to "Follow chat model", unknown saved models preserved
  without a model probe, coarse-pointer touch targets.
- The Remote WebUI has no settings dialog. It reads the same Host row on mount,
  on focus/visibility and through its socket, so its composer behaves like the
  desktop one. Forward each socket event to the settings hook's `handleEvent`
  and pass `${resyncKey}:${snapshotRefreshKey}` as `refreshKey` so recovery also
  reloads changes that were missed while disconnected.

## 4. Validation & Error Matrix

| Condition | Behavior |
| --- | --- |
| Unknown Connection | Command error / HTTP 400; no settings write |
| Empty or overlong model provider/ID (>256/>512 bytes) | Reject save; retain old settings |
| Disabled Connection | Reject the call; no Pi process |
| Empty draft after trimming | Reject before spawning |
| Generation timeout, error stop reason or dead process | Error with the real reason; session cleaned up |
| Reply empty after normalization | Error; the draft stays |
| Draft changed while waiting | Discard the reply; never overwrite input |

## 5. Good / Base / Bad Cases

- Good: two clients share one Connection row; enabling on the desktop makes the
  WebUI control appear, and both use the configured model.
- Good: a reply that ends with a fenced snippet is written back unchanged.
- Base: disabled by default; a fresh Connection shows no control until enabled.
- Bad: stripping any trailing fence, which hands the composer a broken snippet.
- Bad: a client-supplied "enabled" flag, which a forged request could bypass.

## 6. Tests Required

`runtime/prompt_enhancement.rs` covers short/long draft clipping, an outer
fence, an inner code block, separate leading/trailing blocks (LF and CRLF),
inline backticks, an unclosed leading fence, single- vs multi-pair quotes and
empty replies. `runtime/storage.rs` covers the disabled default,
enable/disable keeping the model, a monotonic revision and unknown Connections.
`tests/unit/prompt-enhancement.test.ts` covers model trimming and incomplete
models; `tests/unit/settings-copy.test.ts` keeps the new tab label within the
Chinese copy rule. `tests/browser/prompt-enhancement.html` exercises the real
shared composer on desktop/mobile layouts: unchanged replies, ownership
switches (including A → B → A), edits/reverts, unmount and focus isolation. It
also checks Host settings events and both recovery refresh keys on the shared
settings hook; it does not establish a real authenticated WebSocket connection.

Manual integration validation must use an isolated Host, authenticated WebUI,
and real Pi/model calls, not just the component fixture. Check successful
fill/focus, equal drafts across real sessions, A → B → A, edits while waiting,
leading/trailing snippets, settings pushes without a settings GET, and a settings
reload after closing/reopening the actual WebSocket. Confirm throwaway Pi
processes exit and do not add session JSONL files. Keep test data/configuration
inside the project and remove temporary launch hooks and copied credentials.

A narrow browser viewport validates responsive layout, not physical touch or
soft-keyboard behavior. Windows desktop, WSL/SSH execution, and physical-device
validation remain separate checks; Local WebUI results do not stand in for them.

## 7. Wrong vs Correct

Wrong: apply the deadline only to the event loop, so a slow WSL/SSH start eats
the Router budget. Correct: one deadline for the whole operation including the
stop call.

Wrong: flatten every Windows system prompt, losing paragraph structure for
native launchers. Correct: flatten only for `.cmd`/`.bat` launchers that go
through `cmd.exe`.

Wrong: keep the enable flag in localStorage or accept it from the request.
Correct: persist it per Connection in the Host and re-read it on every call.
