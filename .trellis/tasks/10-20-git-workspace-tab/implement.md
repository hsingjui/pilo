# Desktop Git Tab — Implementation Plan

Status: desktop-only scope approved; implementation and source review complete. The revised view was inspected in the existing Windows window. Full runtime acceptance and tests/builds remain pending authorization; no commit has been made. WebUI Git adapter and HTTP changes were withdrawn.

## Before Continuing

- [x] Load trellis-before-dev and inspect frontend workspace/component/hook/state/type specs and relevant backend contracts.
- [x] Inspect workspace callers, both entry points, current Git commands and existing workspace tests without modifying tests.
- [x] Obtain approval of the revised final summary (desktop-only Git; complete right-sidebar removal).

## Ordered Work

1. [x] Complete explicit chat/file/Git workspace selection, singleton open/close, project pruning and all active-path consumer updates. Preserve existing chat/file semantics.
2. [x] Keep existing desktop Tauri Git wrappers and command contracts. Harden project-relative literal paths and disable external diff/textconv. Handle projects inside repository subdirectories without reading through host paths. Do not extend PiloClient or WebUI transport/routes.
3. [x] Extract the existing read-only unified diff/status/list into the lazy desktop Git workspace view with manual refresh, clean/error/loading states, stale-request protection and narrow-screen list/detail/back.
4. [x] Add native-only Git icon/tab/panel integration to shared workspace/header, including landing, temporary and loading views. Keep chat mounted/inert when appropriate and find unavailable under Git. WebUI shows no Git UI.
5. [x] Delete the dormant right sidebar and exclusively owned frontend pages, obsolete callback props/imports/refs/labels. Preserve left resize controls, terminal, file links and independent backend capabilities.
6. [x] Review all diffs/references; update workspace specs and record actual verification.

## Planned Acceptance Checks — Require Authorization

- Desktop/Windows: singleton tab open/close/reopen; staged/unstaged/untracked/renamed/deleted/binary files; clean, non-repository and disconnected/error states.
- External file changes + manual refresh; rapid mode/file/project switches; no stale data publication.
- Git/chat/file switching during a live response preserves controller, scroll, composer and existing file access.
- Sidebar/toggle/separator removal does not change left navigation/terminal; it was already disabled by default.
- Local/WSL/SSH reads remain in the saved project environment, including repository subdirectory paths.
- Narrow/touch desktop: list/detail/back, horizontal scrolling, tab overflow/close, focus and insets.
- WebUI: no Git icon/tab or browser Git route, existing chat/workspace layout preserved.

## Validation Commands — Do Not Run Tests/Builds Without User Request

Frontend: pnpm format; pnpm check; pnpm build.

Rust: cargo fmt --all --check; cargo check; cargo clippy --all-targets --all-features -- -D warnings.

Windows desktop only: pnpm tauri dev. Do not launch native desktop from WSL.

Do not create/modify tests without separate approval. The existing tests/unit/project-workspace.test.ts asserts the old workspace state shape; flag the pending adaptation instead of silently modifying it. Distinguish source inspection/formatting from executed runtime validation.

## Finish and Rollback

- [x] Load trellis-check for final source/spec review; run only permitted static checks.
- [x] Update shared workspace/component specs to document desktop-only Git and sidebar removal.
- [x] Update task progress and report changes, untouched tests and unexecuted checks honestly.
- [ ] Commit only with user approval; no release/version changes.

Workspace selection consumers are the highest-risk boundary. Recheck current callers before deleting frontend pages; do not widen into backend capability deletion. Roll back only related task changes if necessary.

## Actual Verification

- `pnpm exec tsc --noEmit`: passed after implementation and final locale cleanup.
- Targeted `pnpm exec oxlint ... --react-plugin --jsx-a11y-plugin --deny-warnings`: passed for all 13 affected/new frontend files.
- Targeted `pnpm exec oxfmt --write ...`: formatted affected source only.
- `rustfmt --edition 2024 src-tauri/src/runtime/git.rs`: formatted the changed Rust file; this is not compilation.
- `git diff --check`: passed. Source-wide reference review found no right-sidebar components/callbacks or new browser Git route; remote clients and HTTP sources have no retained changes.
- No tests were created, modified or executed. `tests/unit/project-workspace.test.ts` still asserts the old activePath structure and requires separate approval to adapt to activeTab/gitOpen.
- No frontend build, cargo check/clippy, dev server, desktop window or browser acceptance run. Local/WSL/SSH runtime behavior and narrow/touch rendering still need actual validation, with desktop runs on Windows.
- No commit/release/tag/archive. Task remains in_progress pending acceptance and user-approved finish steps.


## Approved Visual Revision — 2026-10-20

- User requested a visual improvement, accepted the `@pierre/diffs` recommendation and explicitly approved installing it (including external pnpm cache writes).
- Installed `@pierre/diffs@1.5.2` with `pnpm add ... --ignore-scripts`; updated only its manifest/lockfile dependency entries. This is a read-only renderer, not an editable Monaco replacement.
- Replaced paginated text coloring with strict patch parsing, virtualized FileDiff rendering, line numbers, local syntax/word-level highlighting, unified/split layouts and wrapping. Unsupported/conflict/truncated input falls back to original inert text; metadata-only/binary changes show returned metadata.
- Refined the Git toolbar, branch/count chips, working/staged segments, filename/directory hierarchy, selected-row rail and localized status badges. Keep existing reads, stale-response protection and native-only boundary unchanged.
- `pnpm exec tsc --noEmit`, targeted four-file oxlint (React/accessibility plugins, deny warnings), targeted oxfmt and `git diff --check`: passed after fixes.
- Used WebDriver only to attach to the already-running **Windows** development app; did not start a dev server or build. Actual rendering showed no Vite or renderer error. Confirmed syntax highlighting, 30 word-diff spans for `src/lib/project-workspace.ts`, two code columns in split mode, wrapping, and automatic unified mode in a temporary **390px Git container** without horizontal root overflow. Narrow back action restored focus to its selected file. Restored container width and wrap preference after inspection.
- Screenshot evidence (ignored project-local logs): `logs/desktop-1792485952339.png` for the narrow/wrapped container; wide captures under the same directory. No browser/Git API was added; no tests or backend files changed in this visual revision.
- This visual inspection is not full desktop acceptance, a unit/integration test run or a build. Dark appearance, huge-patch performance and remaining Local/WSL/SSH/error/clean/binary cases still need dedicated runtime validation. Existing state-shape test adaptation remains separately gated.

## Display Simplification

- User requested filenames only in the file pane and no raw `@@ ... @@` hunk/function headers in the diff.
- Removed the secondary directory line and tightened fine-pointer rows; retained full-path/rename tooltips, path-based identity, selected-file path details and 44px touch targets.
- Changed the renderer’s supported `hunkSeparators` option from `metadata` to `simple`. This preserves small gaps between distinct hunks without displaying patch headers; raw unsupported-format fallback remains unchanged.
- TypeScript no-emit, targeted two-file oxlint/oxfmt and `git diff --check` passed. Attached to the existing Windows app: file-row text contains filenames/status only, full paths remain in titles, and rendered hunk headers are absent with no Vite error. No tests or builds run, no tests changed by this edit.

## Selected Row Simplification

- Removed the Git file list's leading colored selection rail at the user's request. Selected background, status badges and keyboard focus styling remain unchanged.
- Reviewed the class-only edit; targeted oxlint and `git diff --check` passed. No tests, builds or window verification run for this edit.

## Loading Skeletons

- Added shared, theme-neutral workspace/file-list and unified/split diff skeletons using the existing Skeleton primitive. Decorative bones are hidden from assistive technology; localized loading text and reduced-motion behavior are retained.
- Native lazy loading now has a full workspace fallback instead of a blank section. Status reads use the body skeleton without duplicating the toolbar; file/mode changes and diff retries use a code-line skeleton with the current layout. Error/empty states, request timing and stale-result protection are unchanged.
- Targeted three-file oxfmt/oxlint, `pnpm exec tsc --noEmit` and `git diff --check` passed. No tests or builds run; no tests modified by this edit.
- Attached to the running Windows app, but transient loading was not captured (ordinary completed content remained visible). A temporary read-response-delay attempt did not expose the skeleton, and the isolated preview could not locate its module in the resource log. The temporary hook was confirmed restored; no preview overlay was mounted. Loading-state visual acceptance is still pending, not implied by static checks or screenshots of completed content.


## Resizable File/Diff Panes

- Reused the installed react-resizable-panels Group/Panel/Separator; no new dependency or persistence setting. Wide panes have 12rem/20rem minimums, the file pane defaults to 16rem and cannot exceed half the group. Localized separator naming, built-in keyboard resizing and 8px mouse/44px coarse hit regions remain available.
- Width is held in the mounted GitWorkspace, retained across refresh and applied to the loading skeleton. Below the existing 40rem breakpoint, hide the separator/inactive pane and disable resizing while preserving list/detail/back. Restore the saved wide layout when widening; do not save narrow constraint recalculations as user intent.
- Fixed an initial implementation that saved temporary narrow layouts and lost the selected width when widening. Final Windows checks: an adjusted 319.9px list returned to 319.9px after a 390px container round trip and remained 319.9px after refresh. Narrow mode had one full-width pane, no horizontal root overflow and no separator Tab stop. Width overrides were restored; no Vite error observed.
- A DOM pointer-event sequence changed the list from about 319.9px to 396px; keyboard resizing also changed the layout. A native WebDriver pointer-action attempt did not change it, so physical mouse/touch acceptance is not claimed. No desktop server/build was started.
- Final targeted four-file oxfmt/oxlint, TypeScript no-emit and git diff --check passed. No tests or builds run, no test files modified by this edit. Unrelated working-tree changes remain untouched.
