# Desktop Git Workspace Tab

## 1. Scope / Trigger

Git is a desktop-only, project-scoped, read-only workspace tab beside chat and file tabs. WebUI intentionally has no Git entry, tab, client adapter or HTTP route. The old right sidebar and its Files/Agents/Preview frontend pages are removed; independent backend APIs remain. No staging, commit, discard, branch management, history or remote synchronization UI.

Owners: `src/lib/project-workspace.ts`, `src/components/app/project-workspace-{context,tabs,panel}.tsx`, `src/components/chat/chat-session-header.tsx`, `src/components/git-workspace.tsx`, `src/components/git-diff-viewer.tsx`, `src/components/git-workspace-skeleton.tsx`, `src/lib/api/git.ts`, `src-tauri/src/runtime/{git.rs,commands/projects.rs}`.

## 2. Signatures

- `WorkspaceTab = { kind: "chat" } | { kind: "file"; path: string } | { kind: "git" }`.
- `ProjectWorkspace = { files: readonly WorkspaceFile[]; gitOpen: boolean; gitView?: GitWorkspaceView; activeTab: WorkspaceTab }`.
- `GitWorkspaceView` holds `mode`, `selectedPath`, `showDetail`, optional percentage `listWidth`, `diffStyle` and `wrapLines`.
- `useProjectWorkspaces(projectIds)` exposes existing file actions plus `openGit(projectId)`, `closeGit(projectId)` and `updateGitView(projectId, view: Partial<GitWorkspaceView>)`. Reducer actions are `open-git`, `close-git` and `update-git-view`; view patches merge against the latest project state and are ignored when Git is closed. `select` with `path: null` still selects chat.
- `getProjectGitStatus(projectId): Promise<GitStatus>` invokes `project_git_status` with `{ id: projectId }`.
- `getProjectGitDiff(projectId, { path?, staged }): Promise<string>` invokes `project_git_diff` with `{ id: projectId, path: path ?? null, staged }`.
- Rust commands resolve the saved project, then call `git::status(servers, project)` or `git::diff(servers, project, path, staged)`.
- Git status contains nullable `branch` and `files`: each file has `path`, nullable `originalPath`, one-character `indexStatus`/`worktreeStatus`, and `staged`/`unstaged`/`untracked` booleans.

## 3. Contracts

### Workspace and native gate

- One Git tab per project. Reopening selects it, not a duplicate. Files/Git live in memory only and are pruned with deleted projects; do not use fake file paths or add storage migrations. Own Git view preferences in the project workspace, not the mounted chat: session/new-chat/project switches and Git close/reopen retain mode, selection, narrow detail state, width and display preferences. Status/diff responses remain component-local and reload on activation.
- Header, tab strip and panel gate Git with `isTauri()`. Git content is lazy-loaded. Do not widen PiloClient/WebPiloClient or browser transport just because the workspace shell is shared.
- Tab order is chat, Git when open, then files. Closing active Git selects the first file or chat; closing the last active file selects Git when open, otherwise chat. Closing inactive tabs preserves selection. Existing file neighbor selection remains intact.
- Preserve arrows/Home/End/Delete, middle-click close, selected-tab/close-button reveal, and close focus. A landing header with no remaining tabs stays empty; native close focus can return to the Git icon.
- Chat remains mounted with unchanged geometry via visibility/inert. Git overlays only the content panel. Keep landing/temporary headerOverlay and chat-find gating aligned. Session identification does not steal workspace selection; explicit conversation/new-chat selection returns to chat.

### Reads and rendering

- Native Git module loading uses `GitWorkspaceSkeleton` as its Suspense fallback; status reads use the same layout without duplicating the toolbar. `GitDiffSkeleton` replaces the diff body during file/mode changes and retries, matching the effective unified/split layout while keeping selected-file controls in place. Reuse the shared Skeleton primitive with neutral theme colors, reduced-motion support, decorative hidden bones and a localized accessible loading status. Narrow status skeletons show only the file-list pane.
- Fetch status on activation and manual refresh, never background polling. Status/diff completions are ignored after dependency changes or unmount. Diff results are associated with path, mode, status snapshot and retry generation before display, so stale text/errors are never mislabeled.
- Staged mode uses the index; working mode includes untracked files. Diff errors use ErrorState, not a source-code string. Empty textual diffs use the existing no-diff state, including binary/no-text cases.
- `DiffViewer({ diff, diffStyle: "unified" | "split", wrapLines })` uses the approved `@pierre/diffs@1.5.2` dependency: strict `parsePatchFiles`, React `FileDiff` and `Virtualizer`. Virtual scrolling replaces the initial 1,000-line pagination. Keep line numbers, local Shiki syntax highlighting and word-level changes; do not install an editor provider or expose mutation actions.
- Git syntax highlighting uses the fine-grained `src/lib/git-diff-shiki.ts` bundle, not Shiki's full catalog. Keep the shared chat/file loaders unchanged: TypeScript, TSX, JavaScript, JSX, JSON, Bash/Shell, Markdown, Python, Rust, Go, YAML, HTML and CSS. Git additionally allows C, C++, C#, Java, SQL, TOML, XML, Dockerfile and PowerShell, including Shiki aliases and required embedded grammar dependencies. Vite aliases only the exact `shiki` entry; `shiki/core` and engine subpaths stay intact. Diff themes are resolved separately by `@pierre/diffs`.
- Before rendering, configure `@pierre/diffs` extension mappings outside the allowlist as `text`, with `.h` mapped to C. Unsupported languages must keep normal text, line numbers, word-level changes and unified/split diff rendering, not attempt to load removed grammars. Do not import `shiki/langs` or filter its full catalog at runtime: that would still emit every language. Keep C++ macro grammar in its own chunk without capturing shared SQL/GLSL/RegExp dependencies. Production builds use Vite's `shiki/onig.wasm?init` for the optional WASM engine rather than inline base64; the default engine remains JavaScript. Do not raise `chunkSizeWarningLimit` to conceal oversized chunks.
- The renderer follows `resolvedTheme` and Pilo background/foreground/status/font CSS tokens on the shadow host. Use `codeFontSize` for both CSS and virtual line metrics. Include the calculated line height in each `FileDiff` key: the React wrapper in 1.5.2 reads metrics only when constructing its instance, so changing the metrics prop alone leaves virtualization stale. Do not configure a CDN, remote highlighter or patch hydration that reads extra file content.
- Strict parser failures/unsupported formats fall back to inert original diff text with an explanation. Binary/metadata-only output shows Git metadata. Empty output keeps the ordinary no-diff state; neither should render a blank viewport.
- Keep the compact branch/count toolbar and single-line filenames in the file pane; full paths remain in row tooltips and selected-file details. Use `hunkSeparators: "simple"` to keep a small gap between hunks without showing raw `@@ ... @@` headers or function context. Working/staged segments show their counts; status badges have readable names as well as color/letter codes. File toolbar has unified/split and wrap controls, using semantic fieldsets and localized accessible names. Observe the actual diff-pane width: below 600px use unified and disable split, preserving the preferred wide layout for later resizing. No global preference persistence.
- Wide layout uses the existing `react-resizable-panels` Group/Panel/Separator for file-list/diff resizing: initial list 16rem, list minimum 12rem/maximum 50%, diff minimum 20rem, 8px fine/44px coarse hit areas and a localized separator name. Retain built-in keyboard resizing; double-click reset is disabled.
- Use unique panel IDs and project-owned memory-only `gitView.listWidth`; save the initial/user list percentage with `onLayoutChanged`, not every pointer move. Rebuild the ID-keyed Layout with the current mount's panel IDs, since `useId` changes across remounts. Refreshes and skeletons retain the chosen width. Restore the preferred layout through the Group API after narrow-to-wide transitions, rather than saving constraint-driven narrow sizes.
- Below the 40rem root-font breakpoint (matching container styles), disable resizing and hide the separator and inactive Panel via `hidden`, keeping the current list/detail/back interaction and focus behavior. Do not duplicate the file/diff DOM or introduce browser Git UI. Maintain theme tokens and bottom safe-area spacing.

### Connection and path boundary

- Resolve saved projects and run Git through their connection’s command.run. Never read WSL/SSH files via the Host filesystem or synchronize repository directories.
- Scope status and diff to the project directory, including projects inside a larger repository. Porcelain paths are repository-root-relative; strip `rev-parse --show-prefix` before presenting/passing them back as project-relative paths.
- Reject empty/NUL/absolute paths and empty/dot/parent path components; Windows-local validation also recognizes backslash separators and drive prefixes. POSIX backslashes/colons remain literal filename characters. Use `--literal-pathspecs` and an argv `--` boundary; never interpolate into shell text.
- Disable external diff/textconv and pagers. Untracked files retain the existing `--no-index` flow and diff exit code 1 handling. An omitted path reads the project’s changes, not the rest of its parent repository.
- No new environment keys, database records or HTTP endpoints. Preserve existing connection command/transport limits.

## 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Repeated native Git activation | Select the existing project tab |
| Session/project switch or Git close/reopen | Restore that project's view preferences, reload Git data |
| Code font size changes | Recreate FileDiff with matching CSS line height and virtual metrics |
| No project / WebUI | No Git icon or tab; no native Git request |
| Non-repository or disconnected connection | Localized status-error surface with retry, not a clean repository |
| Clean working tree/index | Mode-specific empty state |
| Missing selected file after refresh | Select a remaining file or show empty state |
| File/mode/project change during read | Ignore stale completion; do not relabel old text/errors |
| Git read fails | Separate retryable ErrorState |
| Empty diff | Existing no-text-diff state |
| Binary/metadata-only diff | Informational message plus inert returned Git metadata |
| Unsupported/malformed/combined patch | Original inert diff text, not a crashed or blank viewer |
| Diff pane below 600px | Unified mode, split disabled; restore preferred layout when widened |
| Invalid project-relative diff path | Rust error before Git execution |
| Removed project / closed panel | Prune state; late results cannot reopen it |

## 5. Good / Base / Bad Cases

Good: a WSL subdirectory project shows only its own changed paths and reads its selected diff in that WSL environment. Base: active chat, file tabs and new-chat behavior remain intact; opening Git does not interrupt an agent response. Bad: using a fake filesystem sentinel for Git, exposing a general browser Git proxy, rendering errors as diff text, or deleting independent filesystem/parallel-agent/preview backend APIs along with their obsolete frontend pages.

## 6. Tests Required

`tests/unit/project-workspace.test.ts` covers the explicit activeTab/gitOpen shape, Git singleton/reopen, active/inactive/last-tab close, file deduplication/highlight identity and project pruning. Reducer coverage also verifies partial view patches, project isolation, tab-switch/close/reopen retention, default immutability and ignored late updates after close or project removal. These logic tests do not exercise actual component remounts. Remaining browser/runtime coverage: extend the existing real-header fixture for native-only Git, retained chat/composer/scroll, focus/keyboard/middle close, narrow list/detail, manual refresh, clean/error/binary states and stale request races. Add renderer coverage for split/unified/wrap, theme/font changes, virtual scrolling and raw fallback for unsupported patches. When verification is authorized, check allowlisted syntax (including `.h`, `.sh`, `.yml` and Dockerfile aliases), plain-text diffs for removed languages such as Emacs Lisp, and renames across supported/unsupported extensions. Build output should exclude the full language catalog and inline WASM payload; embedded grammars required by allowed languages may remain. Cover pointer/keyboard resizing, min/max bounds, refresh and narrow-to-wide layout retention, and hidden/unfocusable separators on narrow layouts. Also cover Git view patches, cross-session/project isolation, close/reopen retention, project pruning and remounts with different panel IDs; change code font size on a large scrolled diff and check row alignment. Verify that WebUI remains Git-free.

Rust coverage should include Local/WSL/SSH dispatch, repository subdirectories, staged/working/untracked paths, literal Git pathspec metacharacters, invalid path rejection and no external diff/textconv invocation. Windows desktop runtime checks must run on Windows. Source type/lint checks do not substitute for Rust compilation or desktop verification.

## 7. Wrong vs Correct

Wrong: `activePath = "git"`, browser invoke, a second right-side changes panel, or Git commands run on the desktop Host for a remote project.

Correct: an explicit Git selection, native-gated shared shell, existing typed Tauri wrapper and saved-connection runtime reads, with chat kept mounted underneath.
