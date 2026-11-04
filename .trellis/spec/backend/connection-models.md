# Connection Model Catalog

## 1. Scope / Trigger

Apply to model choices in session naming, next-prompt prediction, prompt enhancement,
and cache keep-alive settings. These policies belong to a Connection, not a Project.
Owners: `runtime/connection_models.rs`, `ServerPiSession::spawn_connection`,
`pilo-server`'s `pi.start`, `useConnectionModels`, and `ConnectionModelCatalog`.

## 2. Signatures

- Tauri `connection_models_get(connectionId) -> PiModel[]`.
- Authenticated HTTP `GET /api/v1/connections/models?connectionId=... -> PiModel[]`.
- `PiloClient.loadConnectionModels(connectionId)` uses the same Host service on
  desktop and WebUI. No database catalog, Project ID, or cache-write endpoint.
- Internal `pi.start` accepts `userScope: boolean` (default false). True requires
  `noSession: true` and no Agent Control stream.

## 3. Contracts

- Resolve the Connection from Host storage. Local, WSL and SSH use their own
  Server/Pi environment. An SSH Connection using Local Pi reads the Local
  Connection's user catalog, while settings remain keyed by the original SSH ID.
- A private, no-session Pi process runs in the Server-owned empty
  `<runtime-root>/model-catalog` directory, not the home directory, any workspace,
  or the most recently used project. Home may itself contain project `.pi` files.
  Keep Pi's user configuration, authentication and user provider extensions.
  Disable built-in tools and context files. No chat attachment, persisted session,
  Agent Control capability, or Project record is created.
- Read the correlated `get_available_models` RPC response; malformed results,
  startup errors, process exit, and timeout are errors, not successful empty lists.
  A genuine empty `models` array is valid. One 35-second budget covers startup,
  the RPC and cleanup, below the HTTP router's 45-second deadline. Session Drop
  schedules cleanup when the deadline expires.
- `useConnectionModels` shares the snapshot and in-flight request per PiloClient
  and Connection execution configuration. All four settings pages use the same
  component for loading, refresh and errors. Automatically load only Connections
  with `shownInHome: true`, matching the sidebar; hidden Connections keep their
  settings rows and explicit refresh without starting Pi on mount. Changing a
  Connection to visible permits the normal deduplicated automatic load. Explicit
  refresh replaces that Connection catalog rather than merging results; it never
  touches project caches.
- Preserve an old saved identity absent from the catalog without reinserting it
  into the dropdown. Show only the short localized "Unavailable" in the trigger;
  dropdown options contain current models only. Never silently clear the setting,
  fabricate an available model, save a substitute, or require an opened project.
- Listing a user model is not an assurance of project availability. For session
  naming and enhancement, `pi_oneshot` resolves an explicit provider/ID using
  `get_available_models` in the actual isolated project process, checks an exact
  match, uses `set_model`, and verifies the returned identity before sending text.
  Do not rely on CLI fuzzy matching or fallback. Existing resource isolation stays
  in force; unavailable extension-only providers are errors rather than substitutes.
- Prediction keeps the actual session's exact registry/auth checks. Its unavailable
  result is visible in both composers without changing the primary model. Naming
  failures produce a toast; enhancement failures preserve the draft and show detail.
- Project chat catalogs/Scope retain their existing project-based behavior. This
  contract does not introduce project overrides for Connection-owned policies.

## 4. Validation & Error Matrix

| Condition | Behavior |
| --- | --- |
| Visible Connection with no projects | Query its user catalog; refresh remains enabled |
| Hidden Connection | No automatic Pi probe; explicit refresh remains enabled |
| Project A declares a private model | Do not leak it into the Connection settings |
| Unknown Connection | Command error / HTTP 400; no Pi process |
| Fresh catalog excludes a saved model | Retain identity; short unavailable trigger, no stale dropdown item |
| Refresh fails | Show error; do not replace the snapshot with a fake empty result |
| Target absent/auth unavailable in execution process | Fail before sending private text; no fallback |
| `set_model` returns a different identity | Error before generation |
| Probe exceeds budget | Report timeout and clean up the private process |

## 5. Good / Base / Bad Cases

- Good: a new SSH Connection offers its user-configured models without adding a project.
- Base: a valid empty catalog still permits follow-current-model or disabling naming.
- Bad: concatenate `loadModels(projectId)` across every project under a Connection.
- Bad: refresh only the most recently opened workspace and retain the others' stale models.

## 6. Tests Required

When authorized to add/run tests, cover a zero-project Connection, disjoint project
providers, replacing a user catalog on refresh, shared in-flight reads and snapshot
updates, saved missing selections, Local-Pi SSH routing, exact model/auth rejection,
`set_model` identity mismatch, and cleanup on RPC/process errors and timeout.
Integration checks need Local/WSL/SSH and both clients; static review and formatting
alone do not establish runtime success. Do not modify tests without user approval.

## 7. Wrong vs Correct

Wrong: a Connection policy receives the union of historical project model caches.
Correct: query the Connection's Pi user environment independently, then recheck
exact availability inside the process that will perform the operation.
