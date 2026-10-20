# File Links & Project Workspace Tabs

## 1. Scope / Trigger

Desktop Markdown `file://` links open Markdown/code as read-only tabs beside
the conversation title for Local, WSL and SSH projects. Allowlisted documents
(including HTML reports) use the system default application; unknown file types
are rejected. WSL/SSH documents are bounded, disposable local snapshots, read on
the selected connection without an HTTP server or project-directory sync.
WebUI remains unsupported for native file access; never reinterpret remote paths
as desktop-local paths. Desktop-only read-only Git tabs share the workspace shell;
see [Git Workspace Tab](./git-workspace.md). WebUI has no Git UI or routes.

## 2. Signatures

- `resolveMarkdownFileUrl(value: string): string | null`
- `fileLinkPreviewKind(path: string): "markdown" | "code" | null`
- `projectMarkdownImageScope(project: Pick<Project, "id" | "path">, filePath: string): ChatProjectImageScope | null`
- `resolveMarkdownImageSource(src?: string, baseDirectory?: string): MarkdownImageSource`
  uses a project-relative Markdown directory only when supplied; chat keeps its
  existing project-root-relative, no-parent-traversal behavior.
- `openFileLink(project: Pick<Project, "id" | "connection"> | null, url: string): Promise<WorkspaceFile | null>`
- Command: `project_file_link_open(project_id: String, url: String, preview: bool) -> Result<Option<FileLinkPreview>, String>`
- IPC: `{ projectId: string, url: string, preview: boolean }`.
  Preview response: `{ path: string, content: string }` with canonical absolute path;
  system opening response: `null`.
- Legacy `project_html_report_open` and `openHtmlReport` retain HTML-only behavior
  for Local/WSL/SSH.
- Server RPC `file_link.read { path: string, preview: boolean }` returns
  `{ path: string }` with a canonical absolute path and exactly one binary
  attachment. `path` is absolute on the saved project's connection, not the Host.
  No WebUI route is registered for this operation.
- `projectEditorUrl(project, editor, targetPath = project.path): string` builds
  an editor URL for a project directory or the selected absolute file path.
- `openProjectInEditor(project, editor, path?: string): Promise<void>` preserves
  the connection environment and existing editor selection.
- `project_open_in_zed_wsl(app, id: String, path: Option<String>) -> Result<(), String>`
  accepts optional IPC `{ id, path? }`; omitting `path` retains project opening.
- `useProjectWorkspaces(projectIds)` owns `{ state, openFile, selectFile, closeFile, openGit, closeGit, highlightFile }`.
  `state` maps project IDs to `{ files: readonly WorkspaceFile[], gitOpen: boolean, activeTab: WorkspaceTab }`.
  `WorkspaceTab` discriminates chat, file with path, and Git; `selectFile(id, null)`
  still selects chat. Files have `{ path, content, html?: string | null }`.

Owners: `src/lib/chat/chat-markdown-links.ts`, `src/lib/api/file-links.ts`,
`src-tauri/src/runtime/file_links.rs`, `src/lib/project-workspace.ts`,
`src/components/app/project-workspace-*.tsx`, `src/components/project-viewer.tsx`.

## 3. Contracts

### Markdown security and link presentation

- Preserve Streamdown's sanitize schema, adding `file` only to `href`; do not change
  image protocols. Plugin order remains raw -> sanitize -> `rehypeFileLinks` ->
  project images -> harden.
- `rehypeFileLinks` transfers sanitized targets to `data-pilo-file-url` and an inert
  HTTPS sentinel. `MarkdownLink` renders a button, never a navigable file anchor.
  Raw HTML cannot spoof metadata because sanitize removes it first.
- File-only paragraphs and tight list items mark their direct file links with
  `data-pilo-file-layout="standalone"` after sanitization. Whitespace and `br`
  separators are allowed; prose, headings and table cells keep lightweight inline
  references. Standalone buttons are content-width, left-aligned rows, stacked
  with 8px gaps; suppress their following `br` to avoid duplicate vertical gaps.
  Inline references inherit prose typography and omit attachment icons/fill.
- File links shorten URL-only labels to decoded filenames, preserve custom/formatted
  labels and retain full URL in `title`. Standalone labels truncate without
  shrinking icons; inline labels wrap long tokens. Both styles expose visible
  focus and a 44px coarse-pointer hit target. Disable while opening.
- Label shortening belongs in `rehypeFileLinks`, shared by rendering and
  `markdownSearchText`. File buttons opt into DOM matching with
  `data-chat-search-reference`; the projection uses matching text boundaries.
  `[Report](file:///tmp/report.html) Report` must have two ordered highlights.
  Search URL-only chips by their displayed filename, never the hidden directory.
- No reads or system launches during render; activation uses the actual project's
  `ChatMarkdownLinkScope`. WebUI rejects before desktop IPC.

### Reading and system opening

- Backend independently resolves the saved project before touching the filesystem.
  Local uses host file URL semantics; WSL/SSH URL decoding is OS-independent, then
  delegates to `file_link.read` on the selected connection. A Windows Host must not
  call `Url::to_file_path` on a remote POSIX URL. Both branches validate URLs,
  canonicalize in the owning environment and require a regular file.
- Preview reads are bounded to 1 MiB (including a growth check during reading),
  require UTF-8, and reject NUL bytes. Scripts are text only, never executed.
- System opening allows only `html`, `htm`, `pdf`, `txt`, `md`, `markdown`,
  `csv`, `png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`, `ico`, `tif`, `tiff`, `avif`
  on both original and canonical names. Unknown types (including XML `.wsb`
  Sandbox launch configurations) are rejected, not handled by a growing denylist.
  Retain executable signatures/shebangs and Unix executable-bit checks even for
  allowed extensions. Use Rust `OpenerExt::open_path`, not broad frontend opener
  permissions. Document extension/header checks are shared by Host and server in
  `crates/pilo-server/src/file_links.rs`.
- Remote preview transfers are bounded to 1 MiB; remote document transfers are
  bounded to `MAX_BINARY_PAYLOAD_BYTES` (32 MiB). Check size again after a bounded
  read to reject growth. The Host independently checks attachment count, preview
  encoding/size and system document types/signatures.
- Remote documents are written with a random safe basename and the validated
  canonical extension under `app_cache_dir()/file-links/`. Use exclusive creation,
  private Unix directory/file modes and flush/close before launch. Failed
  write/open operations remove their snapshot; later opens best-effort remove
  snapshots older than seven days. Snapshots are not authoritative files and do
  not preserve relative HTML assets. Prefer self-contained reports; never
  synchronize adjacent remote files or start a web server implicitly.
- Links may be outside the project (HTML skills often write under the user's home).
  No generic filesystem permission or remote endpoint is added.
- Retained project-file APIs keep their separate read contracts and
  5 MiB text-preview limit via `readProjectTextFile`; the sidebar UI is removed.

### Shared workspace UI and lifecycle

- Desktop and WebUI provide the same `ProjectWorkspaceContext`, `SessionHeader`
  tab strip and `ProjectWorkspacePanel`. No modal or second viewer title bar.
- With no session, files or Git tab, keep the landing header empty rather than
  rendering a default new-session tab. Standalone session titles have no selected
  fill; show the selection background when file/Git tabs exist. Preserve temporary
  chat's dashed identifier and provide a new-session return tab while a landing
  preview/Git tab is open. Closing the last workspace tab restores the empty header.
- Workspace state is in-memory and per project, not per session. Switching
  conversations preserves that project's files; selecting a conversation/new chat
  on desktop explicitly returns to chat. Runtime session identification must not
  steal selection from a preview.
- Duplicate paths select the existing tab without replacing content. Normalize
  Windows separators, canonical verbatim drive prefixes (`\\\\?\\`) and drive-path case;
  preserve POSIX case. Backend canonical
  paths deduplicate symlink targets after reading.
- Close active file -> adjacent file -> Git if open, otherwise chat when the last
  file closes; closing an inactive file does not change selection. Closing restores
  selected-tab focus, or the native Git icon if the landing header becomes empty.
- Removed projects are pruned; pending reads cannot reopen a removed project.
  Highlight responses apply only to the exact still-open file object, so stale
  close/reopen results cannot replace new content. Close releases cached HTML.
- Keep chat mounted and geometrically unchanged using `visibility` + `inert`,
  not `display: none`. Preview overlays the chat panel only, preserving header,
  composer, scroll position, and running controller. For landing/empty temporary
  chats, pass the same overlay flag to `SessionHeader` and the panel's `headerOverlay`:
  keep the header absolute above the inset preview instead of changing chat height.
  Loading fallbacks must also pass their project to the header. Disable hidden chat find.
- Markdown reuses sanitized `ChatMarkdown`; MDX and HTML source in the
  file viewer remain inert code. Code reuses the existing highlighter with escaped
  plain-text fallback and configured code font. Share `--pilo-shiki-*` semantic
  color variables with Markdown code blocks; emitted token spans alone do not
  produce syntax colors. No editor/save/run actions.
- Each Markdown preview supplies its own stable `ChatMarkdownImageScopeProvider`,
  with `baseDirectory` relative to the project root and a file-specific session key.
  Resolve `./diagram.png` from the Markdown file's directory; normalize `..`
  only while it stays inside the project, then pass a traversal-free relative path
  to the existing image-only API (which still canonicalizes and rejects symlink
  escapes). Documents outside the project get a null image scope, not access to
  adjacent system files. Compare project/file paths with Windows canonical drive
  normalization. WebUI passes its existing `readImage` callback through
  `ProjectWorkspacePanel`/`ProjectViewer`, never desktop IPC or a new filesystem
  endpoint.
- File panels stay mounted while toggling tabs within the same viewer to retain
  preview scroll. Tab strip scrolls horizontally, reveals selected file **and its
  close button** on selection/resize, and supports arrows, Home/End, Delete.
  With files open, chat/file labels share a 14rem cap and shrink with ellipsis
  before the strip scrolls at their minimum widths. Full titles/paths use the
  shared `Hint` component, never native `title` tooltips. `Hint` uses `asChild`
  so the button remains the direct flex child and the close button stays visible.
  The whole file-tab wrapper owns selected/hover fills; keep its title button
  transparent to avoid a separate rounded hover patch beside the close button.
  Coarse-pointer tabs/close controls have 44px hit targets; file-tab outlines
  are inset rings so they do not increase the touch row height.
- Tab icons distinguish Markdown/text, source, JSON, configuration, styles and
  shell/build scripts using existing Lucide icons. Match basenames/extensions
  case-insensitively and handle both path separators; no new icon dependency.
- `SessionHeader` passes the active workspace path to `ProjectEditorMenu`. Both
  the main editor button and choosing an editor target that file, with localized
  filename-aware tooltips. Returning to chat restores project-directory opening.
  No editor is launched during render or tab selection. WebUI keeps its existing
  guard: no native editor menu or new filesystem/launch endpoint.
- Editor URLs encode spaces, Unicode and fragments and retain Local/WSL/SSH
  connection routing. Windows Zed WSL passes the optional path through its
  existing CLI launcher (`--wsl <distro> -- <path>`), not a local UNC URL; absent
  path defaults to the saved project directory. Paths remain separate argv, not
  shell text; only saved WSL projects can use that command.
- Middle-button `auxclick` anywhere on a file tab (including its close icon)
  closes that file once through the existing close/focus flow. Prevent middle
  `mousedown` defaults too, to suppress Windows autoscroll/Linux paste. Right
  clicks and middle clicks on the permanent conversation tab do not close it.
- Both Markdown and code panels use an inset, rounded 1px semantic `border-border`
  frame. Keep overflow/scroll inside that frame and preserve the chat geometry.

## 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Desktop Local/WSL/SSH `.md` / `.markdown` | Sanitized Markdown workspace tab |
| Known code/text extension or supported text basename | Read-only highlighted/plain-text tab |
| Allowlisted HTML, PDF, text and raster image documents | System-default application |
| Unknown system-open extension, including `.wsb` or macro documents | Reject |
| Project Markdown local image | Resolve from document directory via bounded project image API |
| Image traversal above project root or document outside project | Unavailable; no image read |
| Preview >1 MiB, NUL, invalid UTF-8 | Error toast; no partial/new tab |
| Windows drive URL, Unicode/spaces | Decode for the selected environment; remote POSIX URLs work on a Windows Host |
| Remote hostname, UNC/device path, encoded slash/backslash, ADS | Reject |
| Query/fragment (even empty), controls, malformed encoding, >4096 URL | Reject |
| Missing file or directory | Reject |
| Executable, script or shortcut requested for system opening | Reject (safe text preview may still be allowed) |
| WSL/SSH code/text | Bounded preview through the selected connection; canonical remote path retained |
| WSL/SSH allowlisted documents | Bounded cache snapshot, then system-default application; no HTTP server |
| Remote document >32 MiB | Reject before transfer and after bounded reading |
| Remote HTML with relative assets | Only the linked document is copied; adjacent assets are not synchronized |
| WebUI | Localized unsupported hint; no desktop IPC |
| HTTP(S)/mailto | Existing external-anchor behavior |
| Editor click with a file selected | Open that file in the chosen editor/environment |
| Editor click with chat selected | Preserve project-directory opening |
| Windows Zed WSL with omitted path | Preserve saved project-directory CLI opening |

## 5. Good / Base / Bad Cases

- Good: `[Notes](file:///Users/me/notes.md)` opens after the conversation tab;
  clicking it again selects the existing tab.
- Base: `[Report](file:///Users/me/report.html)` still opens in the default browser;
  `[Site](https://example.com)` retains external-link security. An SSH report
  under `~/.answer-me-with-html/` is read on SSH and opened as a local snapshot.
- Bad: `file://server/share/report.html`, `file:///C:/run.exe:payload.html`,
  executing Markdown scripts, automatically opening during render, or mounting a
  separate modal/header for previews.

## 6. Tests Required

- `tests/unit/chat-markdown-links.test.ts`: URL guards, static/streaming Markdown,
  raw anchors, spoofed metadata, label formatting, visible-label search projection,
  file-chip search markers and external-link security.
- `tests/unit/chat-markdown-images.test.ts`: preview scopes at project root and
  nested directories, Windows canonical paths, contained parent image paths,
  above-root traversal and outside-project document rejection.
- `tests/unit/project-editor.test.ts`: project/file URL targets, encoded Windows
  verbatim/Unicode/space/hash paths, WSL/SSH routing, optional Windows Zed WSL IPC
  path and existing project-directory fallback.
- `tests/unit/project-workspace.test.ts`: routing, deduplication, path case,
  selection/closing, project pruning and stale highlighting. Its old activePath
  assertions still need adaptation to activeTab/gitOpen, pending separate user
  approval; do not silently edit them during feature implementation.
- `tests/browser/chat-markdown-links.html`: mocked system IPC, desktop connection
  routing and the WebUI guard,
  no automatic opening, focus, 320px light/dark chips and coarse-pointer targets;
  two indexed/DOM `Report` hits with ordered active ranges in static/streaming
  Markdown, raw anchors and filename-only URL labels on desktop/WebUI.
- `tests/browser/project-workspace-tabs.html`: shared real header/panels,
  Markdown/code safety, deduplication, project isolation, retained chat DOM/draft/
  scroll/background updates, keyboard navigation, close focus, compact long
  titles, file-type icons, direct/editor-menu active-file opening, chat-directory
  fallback, WebUI editor guard, shared Hint tooltips, transparent file-title buttons, framed Markdown/code,
  middle-close active/inactive/last tabs and narrow layout. Load real Blob-backed
  local images at root/nested Markdown paths in 940px/320px desktop/WebUI harnesses,
  verify transport selection, contained parent resolution and no outside reads. Cover empty landing
  headers, transparent standalone titles, temporary identifiers and landing
  preview return/close behavior in desktop/WebUI, light/dark and 320px layouts.
- Rust `file_links::tests`: URL/path validation, missing/directory/symlink checks,
  bounded UTF-8 previews, document allowlist, unknown/`.wsb` refusal and executable
  rejection even under an allowed extension.
- Pending explicit authorization: the existing browser fixture still asserts
  WSL/SSH rejection and must be updated for the new desktop routing contract.
  Add coverage for OS-independent POSIX/drive URL decoding, remote canonical paths,
  preview size/encoding rejection, remote document executable bits/signatures and
  symlink names/targets, 32 MiB document/growth limits, cache flush/failed-open
  cleanup/expiry, unchanged Local behavior and unchanged WebUI IPC refusal.
  No tests were created, modified or run for this change.
- Browser fixtures mock native IPC. Actual WSL/SSH file reading/default-app
  launching, standalone report scripts and Windows WebView layout still require
  Windows desktop verification. Rebuild the WSL/SSH `pilo-server` development
  runtime explicitly before trying the new server capability; source edits do not
  update already-built binaries. No build or native verification has been run.

## 7. Wrong vs Correct

- Wrong: loosen sanitization, navigate directly to file URLs, grant generic opener
  access, or hide/unmount chat with `display: none` while a file is active.
- Correct: preserve link metadata through filtering, activate through shared UI,
  validate and read on the selected connection, and overlay preview over an inert,
  geometrically preserved chat panel using per-project workspace state.
