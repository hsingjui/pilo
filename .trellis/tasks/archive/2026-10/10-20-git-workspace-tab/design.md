# Desktop Git Tab — Technical Design

## Scope Revision

The user explicitly removed WebUI Git from scope after implementation began. Desktop is the only Git entry point. Do not extend PiloClient/WebPiloClient, browser transport or authenticated HTTP routes for Git. The experimental adapter/route changes were withdrawn. Shared workspace state and layout must remain compatible with WebUI without exposing Git there.

## Existing Evidence

- `src/App.tsx:71-73` initially disables the retained right sidebar; dormant callback/panel code is at `484-488,558-584`.
- `src/components/right-sidebar.tsx:28-125` implements the paginated unified diff; the remaining component owns status/list/diff selection. It provided the initial renderer, now superseded by the user-approved `@pierre/diffs` integration.
- `src/components/app/project-workspace-{context,tabs,panel}.tsx` is shared by desktop/WebUI. The old workspace stores files and activePath, with null meaning chat.
- `src/components/chat/chat-session-header.tsx` already gates native editor entry with isTauri; use the same native-only boundary for Git.
- `src/lib/api/git.ts` invokes existing `project_git_status` and `project_git_diff`; `src-tauri/src/runtime/commands/projects.rs:147-169` resolves the saved project and delegates to `runtime/git.rs`.
- Git executes through the selected connection’s internal command.run, not the host filesystem.
- Source-wide inspection found FileExplorer, ParallelAgentsPanel and PreviewPanel referenced only by RightSidebar; recheck before deletion.

## Data Flow and Security

Desktop shared Git view -> typed src/lib/api/git.ts wrapper -> existing Tauri commands -> runtime Git -> saved Local/WSL/SSH connection. The UI does not call system commands directly. No new browser API or general shell endpoint.

Keep the existing command contracts compatible. Validate requested paths as project-relative and pass literal pathspecs. Disable external diff/textconv execution. Scope status/diff to the project directory even when it is a repository subdirectory; normalize porcelain root-relative paths to that project’s prefix. Preserve current command/transport limits.

## Workspace Lifecycle

Use explicit chat/file/Git selection, with one gitOpen flag per project, alongside the existing file collection. No fake filesystem sentinel. Preserve file-key normalization, cached highlights, stale-object protection, project pruning and existing file-specific actions.

Opening selects the singleton Git tab. Closing an inactive tab preserves selection; closing the active tab selects a remaining neighboring tab or chat. Keep keyboard arrows/Home/End/Delete, middle-click close, focus return and selected-tab scrolling. Existing file APIs remain file-specific; adapt every activePath consumer.

Keep chat DOM mounted with unchanged geometry using visibility/inert while a non-chat tab is active. Do not stop/restart controllers. Cover header, panel, file viewer, find, new-chat/temporary/loading views and project/chat selection. Git state is memory-only.

## View and Header

Native-only Git icon with a localized accessible label opens Git through workspace context. Do not show it in WebUI. Lazy-load the desktop Git view from the shared panel only when needed.

Retain status/list/diff behavior extracted from RightSidebar. The user approved `@pierre/diffs@1.5.2` to replace the initial 1,000-line paginated text renderer. Parse the existing Git patch with `parsePatchFiles(..., undefined, true)` and render `FileDiff` inside its `Virtualizer`, without editing providers, workers or additional filesystem reads. Use GitHub light/dark syntax themes and bridge Pilo theme/font tokens into the shadow host. Diff font size and virtual row metrics must agree. If parsing fails (including combined conflict output), preserve the original patch as inert text. Binary/metadata-only output shows the returned metadata, not a blank component. Show branch, staged/working selection, file list, refresh and a selected diff; errors are not source text. Fetch on activation/manual refresh, without watchers, and invalidate stale requests on selection/project/unmount.

Wide desktop: file list beside diff using the existing `react-resizable-panels` Group/Panel/Separator. Start the file pane at 16rem, constrain it to at least 12rem and at most half the group, and reserve at least 20rem for the diff. The separator has localized accessible naming and 8px mouse/44px coarse-pointer hit regions; retain built-in keyboard resizing. Narrow desktop: list -> diff with back action. Reuse theme tokens, localized controls, keyboard focus, horizontal diff scrolling and 44px coarse-pointer targets. Respect the shared overlay header arrangement. No mutation controls.

The visual revision uses a compact branch/count toolbar, a subdued file pane with count-bearing working/staged segments, single-line filenames (paths only in tooltips and selected-file details), status colors with readable names and a muted selected-row background without a leading color rail. Use the library’s `simple` hunk separators rather than raw `@@ ... @@` metadata headers. The selected-file toolbar owns unified/split and line-wrap controls. Observe the actual diff-pane width: below 600px force unified mode and disable split, retaining the wide-layout preference when space returns. Preferences are local to the mounted Git view, not persisted globally. Keep the initial/user-adjusted panel layout in GitWorkspace state so status refreshes do not reset it. Below the same 40rem root-font breakpoint as the container styles, disable the Group and hide the separator and inactive pane. Restore the saved wide layout through the Group API when returning to wide mode; do not save temporary constraint-driven narrow layouts as user choices. Loading skeletons use the saved list width with the same wide-layout clamps.

Loading uses the shared Skeleton primitive in `git-workspace-skeleton.tsx`: a full workspace skeleton for the native lazy-module fallback, the same layout without a second toolbar for status reads, and a unified/split code-line skeleton for selected-file reads and retries. Keep theme-neutral bones, reduced-motion support, accessible loading text and the existing narrow list/detail layout; do not change request timing or stale-result handling.

## Removal and Compatibility

Delete RightSidebar, disabled feature flag/import/ref/separator/fallback and onOpenChanges prop chain/header toggle. Remove exclusively owned frontend Files/Agents/Preview pages after caller inspection. Preserve left resize handling, terminal dock, file links/viewer and independent backend APIs. Avoid unrelated dependency cleanup.

No SQLite, conversation or session data migrations. Browser chat and its current lack of native file access remain unchanged. Existing workspace tests encode the old state shape; changes require separate user approval and are not silently patched in this task.

## Rollback

Workspace state, desktop header/panel integration and sidebar removal form one feature change. Review these boundaries separately; revert only this task’s code if needed. No WebUI Git route should exist before or after rollback.
