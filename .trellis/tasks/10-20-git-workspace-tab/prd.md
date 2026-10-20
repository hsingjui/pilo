# Desktop Read-only Git Workspace Tab

## Goal

Let desktop users inspect the current project’s Git changes in a dedicated workspace tab without interrupting the agent conversation. Remove the complete dormant right sidebar.

## Background and Decisions

- The user chose read-only changes, a top-header Git icon and a dedicated tab, then explicitly requested deletion of the entire right sidebar.
- Scope correction after implementation began: **WebUI does not need Git**. Git entry, tab and reads are desktop-only; do not introduce browser Git routes or adapters. Shared layout cleanup still applies to both entry points without breaking WebUI chat.
- The sidebar is already disabled (`src/App.tsx:71-73` at planning time); removing it does not newly free width compared with the default layout.
- Existing desktop Git calls (`src/lib/api/git.ts:18-31`) resolve saved projects and delegate to the connection-aware runtime (`src-tauri/src/runtime/commands/projects.rs:147-169`). Shared workspace selection initially represented only chat and file paths (`src/lib/project-workspace.ts:7-16`).

## Requirements

### R1 — Desktop header entry and project-scoped tab

When a project is available, desktop shows a Git icon with an accessible “View changes” name/tooltip. Clicking opens or selects that project’s single closeable Git tab. Keep tab state in memory, like existing file tabs. WebUI has no Git entry or Git tab.

### R2 — Read-only change inspection

Display the branch, staged/unstaged files including untracked files, the selected file’s diff and manual refresh. Preserve index versus working-tree distinction with line numbers, syntax highlighting, inline changes, unified/split layout and wrapping. Use the approved read-only diff dependency; keep large diffs readable without manual line pagination. Distinguish loading, clean, non-repository/unavailable and request-error states. Ignore stale reads after project/selection changes. Execute Git in the project’s Local/WSL/SSH environment, without local repository synchronization or mutation controls.

### R3 — Complete right-sidebar removal

Remove the panel, toggle, resize separator, dedicated state and exclusively owned frontend Files/Agents/Preview pages. Do not relocate those pages. Retain chat file-link viewing, file tabs, left navigation and terminal. Do not remove independent backend capabilities or APIs.

### R4 — Workspace behavior and compatibility

Chat remains mounted and active agent work continues while desktop Git is selected. Preserve existing chat/file navigation, focus and project isolation. Wide desktop uses a file list beside the diff with a draggable divider and minimum pane widths; narrow/touch desktop supports entering a diff and returning to the list, keyboard tab navigation, sufficient touch targets and appropriate viewport insets. Shared component changes must not introduce Git UI or regress chat/layout in WebUI.

## Acceptance Criteria

- AC1 (R1): Desktop header opens exactly one Git tab per project; repeated clicks select it; close/reopen work.
- AC2 (R1, R4): Switching projects/chat/files/Git preserves isolation, conversation state and existing file access.
- AC3 (R2): Staged, unstaged and untracked files have correct read-only diffs; refresh reflects current repository changes; clean/error/loading states are distinct.
- AC4 (R3): Right-sidebar code, toggle and resize strip are removed; no replacement Files/Agents/Preview UI is added; left navigation and terminal remain intact.
- AC5 (R4): Wide/narrow desktop and keyboard/touch navigation work; WebUI has no Git entry/tab and retains its existing chat/layout.
- AC6 (R2): Desktop Local/WSL/SSH Git reads use the saved project connection and cannot reinterpret paths as host-local paths. No WebUI Git endpoint is registered.

## Out of Scope

- WebUI Git entry, tab, client adapter, HTTP routes or other browser Git access.
- Staging/unstaging, commit/discard/reset, branches/history, fetch/pull/push, merge/rebase.
- Replacement pages for removed sidebar tools, or removal of their independent backend capabilities.
- Background Git watchers, restart persistence and editable diff/editor behavior. The user explicitly approved installing `@pierre/diffs` for read-only rendering and its pnpm cache writes.
- Test creation/modification without separate approval; tests/builds without an explicit verification request.

## Risks and Deferred Items

- Shared workspace selection affects viewers, find, landing/loading views and per-project pruning. Existing workspace tests bind to the old state shape; they remain untouched pending separate approval to update them.
- Large diffs remain subject to current transport limits. Rendering is virtualized; transport streaming is deferred.
- Desktop runtime validation must run on Windows, not WSL. No runtime correctness is implied by source inspection.

## Planning Status

The user approved the revised desktop-only summary and requested continued implementation. Git UI, the approved visual revision using `@pierre/diffs`, and right-sidebar removal are implemented. TypeScript and targeted frontend lint pass. The revised Git view was inspected in the existing Windows development window, including layout/wrap and a 390px container; full runtime acceptance, Rust compilation and tests/builds remain pending. Existing workspace tests are unchanged and still need separate approval for state-shape adaptation. No unresolved product behavior questions remain.
