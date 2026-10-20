# Component Guidelines

> React component patterns used in this codebase.

---

## Component Style

- Function components only. No class components except the root error boundary
  in `src/main.tsx`.
- Named exports: `export function ChatCopyButton(...)`. `src/App.tsx` uses a
  default export because `main.tsx` imports it that way.
- Inline the props type for small components; declare a named `Props`/options
  type when it is reused or large.

```tsx
export function ChatCopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	...
}
```

## `src/ui` Primitives

Follow the shadcn/ui shape:

- `cva(...)` for variants.
- `React.forwardRef` with a `displayName`.
- `asChild` support via `@radix-ui/react-slot` for polymorphic primitives.
- Classes merged with `cn()` from `@/lib/utils`.

```tsx
const buttonVariants = cva("inline-flex ...", {
	variants: {
		variant: { default: "...", ghost: "...", outline: "..." },
		size: { default: "h-9 px-4 py-2", sm: "h-8 ...", icon: "h-9 w-9" },
	},
	defaultVariants: { variant: "default", size: "default" },
});
```

Feature code composes primitives with `variant`/`size` props instead of
re-styling them.

## Composition & Layout

- Feature components own their layout and state; primitives stay dumb.
- Long/multi-part UI is split into focused files co-located in the feature folder
  (e.g. `chat-composer.tsx`, `chat-composer-frame.tsx`, `chat-composer-actions.tsx`).
- Heavy features are lazy-loaded with `React.lazy` + `Suspense` in `src/App.tsx`
  (`ChatPage`, `ProjectViewer`, `RightSidebar`, `TerminalDock`).
- Startup loading boundaries apply to desktop and WebUI: `ChatMarkdown` starts
  its shared runtime import on the first rendered message, not at module scope;
  importing/prewarming `ChatPage` must not fetch the Markdown engine for an empty
  draft. Both sidebar and mobile command palettes use `lazy` + `Suspense` only
  when opened. `ComposerRunConfig` also lazy-loads `ChatModelPicker` only when
  its desktop submenu or touch sheet mounts. Keep the trigger eager; compact
  pickers focus their search input on mount after loading, while touch sheets
  must not automatically summon the soft keyboard. Desktop debug API imports
  belong inside `import.meta.env.DEV`; load desktop logging and `App` in parallel
  but finish logging setup before rendering. WebUI service-worker registration
  waits for `document.readyState === "complete"` or a one-shot window `load`
  event, removed on cleanup, so precaching does not contend with initial assets.
- Chat and project-file highlighting share `getCodeHighlighter(language)` from
  `src/lib/code-highlighter.ts`, using one JS regex engine and CSS-variable theme.
  Load only the requested grammar (plus its bundled dependencies); do not load
  the full supported-language list on the first code block. Cache concurrent
  requests per language and evict failed loads so later requests can retry.
- File-opening links in tool activity rows are limited to built-in `read`,
  `write` and `edit`. Other tools (commands and MCP tools), unsupported paths and
  WebUI retain the original full-row disclosure button and preview tooltip.
  Preserve the original icon/name/preview layout; do not impose a fixed 50%
  name width or split every tool row to support a file-opening feature.
- Only rows with an openable `read`/`write`/`edit` path use a relative wrapper
  with an absolute full-row disclosure button and a file button above it.
  Share the original row content between both variants. Keep buttons separate
  (never nested), keyboard activation and visible focus rings. Blank space
  expands details; file clicks only open the viewer. When verification is
  authorized, cover long commands/MCP names, read/write/edit file clicks,
  unsupported paths and status icons on desktop and 320px WebUI.
- `useChatFileOpener(openFile, canOpenFile)` publishes the viewer capability with
  its action. `canOpenFile` reuses `projectRelativePath` from the same active
  project as `openFile`; render project-external absolute paths as plain text,
  not buttons that silently return. WebUI registers no opener. When verification
  is authorized, cover project-relative/absolute paths, external Skill paths,
  project switches, preview/blank-space clicks and independent file activation.

## Large Content

- Command palette recency sorting is memoized O(n log n), not repeated insertion.
  Content search runs projects serially and skips superseded queued queries;
  an already-started project scan still finishes. The server allows at most two
  concurrent content scans per connection server, separate from its 64-request
  overall limit. This is admission control, not cancellation of blocking scans.
- Mobile project sessions initially reveal 50 rows, then append batches of 50
  when a sentinel comes within 240px of the drawer scroll viewport's bottom.
  Keep earlier rows mounted, reveal through the selected session's batch, and
  disconnect observers on cleanup. This limits rendering, not fetched data.
  Keep selection/deletion available with 44px touch targets and announce the
  visible/total count. Recent sessions retain their existing 50-row limit;
  desktop/wide WebUI navigation is unchanged.
- Project previews share `SessionHeader` tabs via `ProjectWorkspaceContext`,
  keyed by project rather than conversation. `ProjectWorkspacePanel` preserves
  hidden chat geometry with `visibility` + `inert`; do not unmount or use
  `display: none` for chat. See [File Links & Workspace Tabs](./html-report-links.md).
  Desktop project preview caches highlighting per open tab, including plain-text
  fallback. `highlightProjectFile` skips Shiki above 200,000 code units, 2,000
  lines or 2,000 characters on a line; avoid repeated synchronous tokenization
  when switching tabs. Close drops the tab's cached HTML.
- Git diff parsing is memoized and renders at most 1,000 lines per page; changing
  diff resets the displayed page. Paging limits DOM work, not fetched diff size.
  Files/Git remain desktop-only; do not add generic WebUI filesystem endpoints
  to duplicate these views.

## Styling

The visual system - token meanings, the closed type ramp, radius and shadow
rules, and the named design rules - is documented in
[`docs/DESIGN.md`](../../../docs/DESIGN.md). Read it before changing colors,
spacing, type sizes, or control heights.

- Tailwind utility classes only; design tokens via CSS variables
  (`bg-background`, `text-muted-foreground`, `ring-ring`, …). No hardcoded colors.
- Use `size-4` (not `h-4 w-4`) for square icons.
- Icons come from `lucide-react`; pass them as children to primitives.

## Theme Families

- Lody and Claude are built-in token configurations, not privileged component
  branches. `src/styles/lody-theme.css` owns the defaults, and
  `src/styles/claude-theme.css` only overrides token values. Custom CSS overrides
  that same contract. `theme-components.css` is the family-independent native
  renderer; `src/index.css` maps runtime aliases into Tailwind. Do not add
  `claude:` variants, family-conditioned component rules or a template-loading
  path to implement built-in effects. Every new built-in difference must have
  the same customization point available to Custom. See `docs/THEMES.md`.
- Shared native rules belong in the components layer so explicit caller utilities
  still win (e.g. the composer's transparent, borderless textarea). Remove
  conflicting hardcoded utility defaults when moving a property into the token
  renderer. Keep `cn()` overrides working. Shadow utilities reference runtime
  aliases (`--pilo-field-shadow`, `--pilo-button-primary-shadow`, etc.) so focus
  rings are not replaced by a plain `box-shadow` override. Composer hover/focus
  changes its elevation alias, not Tailwind's shadow stack directly.
- Shared sidebar/composer geometry, menu density, selection, floating surfaces,
  field states and touch heights all read public `--pilo-*` tokens. Both presets
  configure these same fields. Claude's edge-attached sidebar and Lody's floating
  sidebar are values of margin/width/height/border/radius/padding/shadow, not
  boolean layout modes. Preserve the compact single-surface composer, mobile
  safe areas, existing touch targets and reduced-motion behavior.
- Shared control geometry uses `--pilo-*` desktop tokens and independent
  `--pilo-mobile-*` defaults, selected through `--pilo-ui-*` aliases in
  `theme-responsive.css`. Mobile means WebUI <=1023px or a no-hover coarse
  pointer; define aliases on the root so portals follow the same selection.
  Never remap public desktop tokens in a media query: unlayered custom CSS
  would beat that remapping and couple the two devices again. Wire both direct
  CSS and Tailwind consumers through the runtime aliases; include the boot
  composer. General mobile controls keep a 44px floor, except the compact chat
  activity disclosures described below. The compact composer keeps its existing
  40px controls and 44px attachment hit area. Caller utilities
  still override component defaults. Mobile-only sheet/segment/drawer roles
  retain their existing token prefixes rather than another mobile alias layer.
- Session row density is device-specific: `--pilo-sidebar-session-*` configures
  desktop/wide WebUI, while `--pilo-mobile-session-*` keeps independent mobile
  defaults. Height tokens are minimums; preserve the mobile `44px` floor and
  delete-confirmation targets. Keep two-line project-context rows and virtual
  row padding on the same token contract; measure the real virtual row rather
  than hardcoding a numeric gap. See `docs/THEMES.md` for the supported tokens.
- Theme-dependent `@theme inline` utilities must reference runtime aliases:
  `--radius-md: var(--pilo-ui-radius-md)` rather than trying to override the inlined
  `--radius-md` in a family scope. Claude's 8/12/16px md/lg/xl scale, 12px bubble
  and 16px composer remain preset values. Tooltip colors and elevation are
  independent roles; include project/session `TooltipContent` when adapting them.
- Keep small floating surfaces, context details, bottom sheets and menus on their
  separate radius roles. Menu/sheet/segment item curves derive from their public
  outer-radius and padding tokens; rendering must use that same padding in both
  normal and scope-editing states. Subtract real border widths, not shadow rings.
  Expose shared geometry through `--pilo-*` tokens instead of family selectors;
  see the radius recipes in `docs/THEMES.md`.
- Review a whole composite surface, not only its parent/list nesting. Touch
  run-config search (normal and scope-editing), scope tabs, refresh, model rows
  and reasoning/scope-editing action buttons share `--pilo-sheet-item-radius`;
  the tab strip adds its 2px inset to that inner curve. Do not leave unrelated
  `xl`/`lg` tiers on these sibling controls after adapting the model rows. Compact
  desktop stays separate.
- `theme-presets.css` is loaded before the inline boot script and imported by
  `index.css` for other shared entry points. Boot styles read the same public
  geometry/palette tokens; never add a second Claude snapshot. Keep its asset
  in VitePWA's CSS precache pattern. Declare
  `@layer theme, base, components, utilities` before injecting cached custom CSS
  so that user CSS cannot accidentally establish the wrong layer order.
  Boot geometry must also match the mounted layout: read cached `uiFontSize`
  with the same 15 default, 12–18 range and `/ 14` scale as PreferencesProvider;
  mobile WebUI stays at 100%. Use sidebar row height/padding/gap tokens, not
  pixel snapshots. Reserve the landing project-picker row (`pilo.boot.hasProjects`
  is only a last-observed visibility hint written by DraftProjectPicker), otherwise
  the centered hero moves when the composer dock grows. Hero logo/gap use rem;
  heading size follows the conversation column's 40rem container breakpoint,
  not viewport width. Wide WebUI retains its sidebar; <=1023px hides it.
  `BootShellRemover` belongs to the ready screen, not the unconditional root
  bootstrap: desktop waits for `projectsReady && connectionsReady`; WebUI waits
  for the first bootstrap attempt to settle, while offline/auth/pairing/error
  screens must still be revealed. Wait for `document.fonts.ready` before the
  removal frame. A first React commit can have no projects yet; revealing it
  moves the hero down, then back up when the picker arrives (~18px observed on
  Windows). Verify the last boot frame against the first uncovered frame and
  later frames through the desktop WebDriver, not just steady-state rectangles.
- `--pilo-conversation-max-width` is the shared desktop/session/WebUI measure;
  omitting it uses device defaults, and narrow WebUI stays full-width.
  Android `theme-color` follows computed `--background` after family/mode/CSS
  changes, not a hardcoded family palette.
- Narrow WebUI (<=1023px) keeps equal composer side margins and aligned message
  edges: omit composer gutter compensation **and** remove the message-only gutter
  with `scrollbar-gutter: auto`, `scrollbar-width: none` and a WebKit scrollbar
  fallback. Keep native scrolling; desktop/wide WebUI retains its stable gutter
  and measured composer compensation. Changing only the composer breaks message
  alignment. Verify `/tests/browser/chat-column-alignment.html` with short and
  overflowing messages, including 1023/1024px. Assert computed gutter policy as
  well as rectangles: overlay-scrollbar systems can conceal an incorrect policy.
- Mermaid SVG colors are snapshots, not live CSS references. In the shared
  `ChatMarkdownBody`, reread tokens in a passive effect after `ThemeProvider`'s
  layout effects for mode, family and custom-CSS changes. Update the memoized
  diagram plugin identity as well as `mermaid.config`: Streamdown 2.6's memo
  comparison ignores the latter, while its Mermaid renderer observes plugin
  identity. Preserve the shared runtime loader and existing Markdown/component
  state; do not remount the whole message to refresh diagrams. When verification
  is authorized, check an existing diagram after Lody/Claude switches, custom-CSS
  updates and system-mode changes on desktop and wide/mobile WebUI.

## Shared Chat Interaction Contracts

- `useChatStickyScroll` keeps per-element resize heights in a ref-backed
  `WeakMap` across observer rebinds. Starting/ending an assistant message must
  not reset the viewport/content baseline: a turn-end error can grow the DOM
  in the same commit that changes `activeAssistantMessageId` to null. Only a
  new element skips its first measurement. Preserve reading ownership; resize
  correction clamps only while following. Observe the active assistant row's
  real content box as well as the outer content and viewport; the message row
  itself is `display: contents`. Virtua updates an ancestor height during its
  row-resize delivery, so observing only that ancestor defers following until
  another frame and visibly displaces the processing status. When verification
  is authorized, sample the status position after resize delivery, not just
  monotonic `scrollTop`, and cover a final multiline error in a plain short chat
  on desktop and WebUI. Resize delivery alone is insufficient: nested markdown
  commits and progressive work reveals can grow a previously delivered ancestor,
  whose next notification is deferred by the browser's resize-depth limit.
  In the same hook, observe content `childList`/`characterData` mutations with
  `subtree: true` and run the same ownership-gated DOM clamp in mutation delivery,
  not a later rAF. Do not observe attributes (virtualizer/style feedback), add a
  second Virtua scroll writer, or pull reading ownership back to bottom. Both
  observers must disconnect on rebind/cleanup. Run
  `/tests/browser/chat-scroll-following.html`: require `data-test-status="passed"`
  for post-rAF task samples during thinking/text bursts, parallel tool insertion,
  partial output, completion, reading and turn-end errors in plain/virtualized
  wide/narrow layouts. Settled-only assertions miss the one-frame regression.
- Keep the live assistant status in normal document flow after the full reply,
  both while following and reading. Do not pin it with `position: sticky` or
  add sticky-inset spacers: when tool details expand or streamed output grows
  past the viewport, a bottom-sticky status floats over that content. Existing
  scroll following owns keeping the latest output visible; status positioning
  must not compensate for fractional scroll rounding by overlapping the reply.
  Run `/tests/browser/chat-streaming-status.html` and require
  `document.body.dataset.testStatus === "passed"`. It checks expanded/collapsed
  and growing tool details, following/reading, plain/virtualized rendering and
  desktop/narrow widths. Before measuring short/growing Markdown replies, wait
  with a bounded deadline for the expected rendered paragraphs, then settle
  layout. A fixed rAF count is not a Markdown-ready signal: the first runtime
  import can suspend, leaving the previous tool layout visible. Keep the geometry
  assertions independent of readiness so overlapping/pinned status still fails.
  Browser layout assertions do not replace real Windows WebView verification of
  automatic scrolling.
- User-bubble and composer outer right edges share `ConversationColumn` geometry.
  The composer sits outside `.chat-scrollbar`, so desktop, WebUI and the loading
  fallback use `useScrollbarGutterWidth` to compensate its actual gutter (zero
  for overlay scrollbars). Rebind after every commit: conditional mounting and
  keyed session switches replace `ref.current` without changing the ref object;
  `[enabled, ref]` alone misses these changes. Disconnect the previous observer
  and cancel pending measurements on cleanup. When verification is authorized,
  compare the edges before/after draft/session switches with both overlay and
  space-consuming scrollbars; an overlay-only check hides missing compensation.
- `ChatConversationViewport` uses `contain: size layout style`, leaving painting
  and clipping to its native overflow scroller rather than adding paint
  containment with `strict`. Keep this shared across plain and virtualized
  conversations. When verification is authorized, check partially covered user
  bubbles and work-duration disclosures on a real Android WebView near the
  composer edge; desktop Chrome's mobile emulation is not equivalent. The Via
  disappearing-content report still needs real-device confirmation.
- Keep the composer's original single-row toolbar, model label truncation,
  visible reasoning level and context percentage across theme families. Preserve
  WebUI's narrow-screen rules in `src/index.css`, including its compact attachment
  gutter and enlarged touch hit areas. Theme changes must not add wrapping or
  hide metadata through container queries.
- The delivery-mode picker stays icon-based and visible while idle or running.
  Send and stop share one primary button: show stop only while running with no
  draft text or attachments; otherwise show send. Do not add a separate stop
  button as part of theme adaptation.
- `summarizeAssistantActivity` counts only completed, non-error tools. Both the
  outer work disclosure and inner activity group retain a failure count; collapsed
  work retains the first error summary. Failed groups do not auto-collapse when
  following text arrives, and failed tool output defaults open. Preserve manual
  disclosure state and search expansion behavior.
- Chat activity disclosures intentionally stay compact on desktop and WebUI,
  including coarse-pointer devices: `ToolCallActivityView` uses `min-h-6` (24px)
  and `AssistantActivityView` uses `min-h-7` (28px). This is a deliberate
  exception to the general 44px mobile floor to keep tool-heavy transcripts
  dense; do not restore `pointer-coarse:min-h-11` as an accessibility fix.
  Preserve keyboard activation, focus-visible rings and `aria-expanded`.
- `ChatImageViewport` anchors Ctrl-wheel zoom to the cursor and touch pinch to
  the gesture midpoint. Ordinary wheel pans only a zoomed image; double-click
  toggles zoom/reset. Pointer capture retargets click/double-click events to the
  viewport: check the recorded gesture origin/movement, not `event.target`, to
  distinguish image gestures from background dismissal.

## Accessibility

- Interactive icon-only controls need `aria-label`.
- Prefer Radix primitives (Dialog, Tooltip, Select, …) for focus and keyboard
  behavior rather than hand-rolled widgets.
- `oxlint` runs the `jsx-a11y` plugin — accessibility warnings are lint failures.

## Header Actions & Menus

- New-chat navigation reuses the current unstarted draft when the target project
  and normal/temporary mode match. Guard in desktop `useAppChatNavigation` and
  WebUI `useRemoteChatDraftActions` before resetting identity, configuration,
  text, images or runtime state. WebUI still closes mobile navigation on reuse.
  Existing/started sessions (including optimistic first-message startup), stale
  selected paths, project changes and mode changes must still create a new draft.
- `SessionHeader` (`src/components/chat/chat-session-header.tsx`) owns the right-side
action group (terminal / temporary chat / panel / session menu). New per-session
actions go there and appear only for persisted sessions (`session && !session.temporary`).
- Session actions that need chat data flow as optional callbacks from `App.tsx`
  through `ChatPage` props (`onRenameSession`, `onOpenInNewWindow`, …). When an
  action targets the focused viewport (e.g. scrolling to a search hit), pass a
  stable callback such as `onNavigate(messageIndex)` instead of a ref — reading
  `ref.current` inside an effect would otherwise fail the `exhaustive-deps` lint.
- Header components expose optional callbacks; they never wire runtime/Pi calls
  themselves. The parent supplies the handlers.
- A newly started desktop chat keeps `ChatSession.id` as its draft controller
  identity, even after Pi identifies the persisted session. Do not replace that
  ID or attach the indexed path just to refresh the menu: runtime/history hooks
  depend on those stable inputs. On desktop, carry `PiAgentState.sessionId` /
  `sessionFile` into the header's `ChatSessionRuntimeState.sessionId` /
  `sessionPath`. Menu display and copy use non-empty live fields, falling back
  to `ChatSession` metadata via `||`; an empty path shows the unavailable label
  and disables copying. WebUI already supplies the Pi identity through
  `headerSession` (identified draft or indexed session); do not duplicate it in
  `chatState`, which can still belong to the previous session during switching.
  Desktop `refreshSessionState(agentState?: PiAgentState)` must publish
  `sessionId` / `sessionFile` / `sessionName` before awaiting session stats;
  delayed or failed stats must not hide a known identity. Pass the already-read
  agent state at turn startup and runtime reattachment, rather than waiting for
  auto-title generation or turn completion. `applyHistoryMetadata` must preserve
  the previous runtime `sessionId` / `sessionPath`: history can finish after
  reattachment and otherwise erase the live identity, exposing the draft ID
  again while the indexed path remains visible.
  `useRestoreActiveChatRuntimes` restores missing controllers only: check the
  latest opened-chat state inside its functional updater and skip an existing
  `controllerId`, including controllers opened while the restore request was
  pending. Never overwrite their bootstrap inputs with a runtime/index snapshot.
  `useChatSessionState` resets live metadata only when the controller ID or
  project ID changes, not when the same session gains a path or initial config
  changes. Clearing it mid-turn exposes the draft ID and loses the title until
  turn completion; stats-only refreshes cannot restore those fields.
  Check displayed and copied values during the first reply (before it ends),
  after restoring an active draft runtime, and after history arrives on desktop.
  Also check both clients after the first message and immediately after
  switching WebUI sessions before history/RPC completes.
- Rename and open-in-new-window remain gated by `ChatSession.sessionPath` plus
  their callbacks, not the live runtime path. Their desktop handlers use the
  opened entry's identity/path; identifying a draft updates `piSessionId` but
  does not attach `entry.session.sessionPath`. A new desktop chat can therefore
  allow copying its live path while rename/open remain hidden. Do not make
  these gates match the copy gate without updating the handlers' data flow.

## Multi-Window (Tauri)

- Create additional windows only through `src/lib/api/window.ts`; do not call the
  Tauri window API directly from components.
- Any new window label pattern must be declared in the `windows` list of
  `src-tauri/capabilities/default.json` (e.g. `"session-*"`), and creating a
  webview window requires the `core:webview:allow-create-webview-window`
  permission. A capability that only lists `"main"` leaves the new window
  without permissions.
- New windows boot stateless: pass state through URL query params and re-resolve
  it once the project index is ready (see `readSessionWindowTarget` and the boot
  effect in `src/App.tsx`, which delegates to `workspace.openSearchSession`).
- In-conversation find uses `findMessageMatches` in `src/lib/chat/chat-message-search.ts`.
  User body text stays literal, but references follow their rendered labels and
  order: optional Skill name, file/session chips, then body. Pass the same scoped
  `byValue` catalog to `findMessageMatches(messages, query, byValue)` as to the
  renderer. Reuse `readChatMentionDraft` for parsing/deduplication and
  `fileMentionName` for file labels; hidden directories, serialized `@` markers
  and resolved session paths are not search hits. Unknown sessions stay literal.
  Sent `PathMentionBadge` buttons opt into DOM matching with
  `data-chat-search-reference`; treat each as a text boundary while still omitting
  other buttons, icons and popover metadata. Indexing raw reference lines while
  ignoring their chip buttons creates counted hits with no highlight.
  Assistant Markdown is projected through
  the same remark/GFM and raw-HTML/sanitize stages used by Streamdown, retaining
  code contents but excluding link destinations, fence markers and image alt
  attributes. Cache projections by immutable content object/source, and skip
  indexing while the finder is closed. Do not use the outline's
  `messageSearchText`, which strips code fences.
  Assistant hits carry `contentId` and `contentOccurrenceIndex`: highlight only
  the matching `data-chat-search-content-id` text section, not the nth hit in
  the currently mounted message (collapsed work changes that numbering).
  Model and DOM matching share `searchTextMatches`: literal, case-insensitive,
  equivalent whitespace. DOM ranges may cross inline/code-token text nodes;
  omit controls and code headers, and separate block elements consistently.
  Streamdown's `[data-streamdown="code-block-body"] > pre > code > span`
  elements are code lines, not inline tokens: insert line boundaries between
  them. Three lines `high`, `light`, `highlight` must produce only one hit for
  `highlight`, while adjacent token spans within one line remain continuous.
  `[Highlight](https://example.com/Highlight) Highlight` has two targets, not
  three; both targets must have a visible active range.
- `ChatFindLayer` owns the active session's `mod+f` shortcut. Read selected
  text before focusing the find input, including native input/textarea ranges
  but excluding password fields. Normalize whitespace and seed a non-empty
  selection; without one, preserve the query. Repeated shortcuts while open
  must also update the query and focus/select the input after rendering.
  Previous/next actions (including Enter/Shift+Enter) must request navigation
  even when the match index stays unchanged: with one match, manually scrolling
  away and pressing either arrow must return to that exact text range.
- `ChatFindLayer` provides the active match to shared message components. A
  selected intermediate-text hit temporarily opens its work disclosure and
  reveals a bounded content window containing the target; leaving the match
  restores manual expansion state. Forward/backward reveal budgets are separate:
  extending one side must not remove already rendered content or load the other
  side. Anchor the target text when extending a search window, including late
  row measurements; ordinary non-search reveal must not stop bottom-following.
  Manual collapse takes precedence over automatic opening for the current hit;
  a different hit resets that override. Toggle the effective open state, not
  the underlying manual state. Thinking/tool details are not indexed and
  must not contribute DOM matches. `jumpToMessageIndex` mounts the target row,
  then the finder aligns the exact text range; message-top corrections must not
  override that alignment. Observe DOM text/child changes while finding so
  expansion and async Markdown rendering refresh highlights. Verify a message
  with two intermediate hits and two final hits: four ordered targets, correct
  active highlight, automatic work reveal and restored folding on close.
- CSS Custom Highlight uses the global `Highlight` constructor with
  `CSS.highlights`, never `CSS.Highlight`. Prefer the DOM library types over
  assertions that conceal an invalid browser API shape.

## Desktop Updates

- `SidebarFooter` owns one `useDesktopUpdate()` instance and passes it to settings
  and `UpdateDialog`. Startup calls `checkForUpdates({ openDialog: false })`;
  manual checks open the dialog when an update exists. Footer clicks only open
  the dialog, including during downloads; closing it must not cancel the update.
- `UpdateDialog` raises its overlay to `z-[var(--z-dialog)]`: settings content
  already uses that layer, above the default overlay layer. Its portal renders
  after settings, with the update content after its own overlay, so settings is
  dimmed while the update dialog remains on top. Do not raise only the content
  or globally change the shared dialog layer to fix this nested case.
- `useReleaseNotes(version, fallbackNotes, enabled)` reads the matching GitHub
  Release's `body` from `/releases/tags/v{version}`, not `/releases/latest`.
  Release notes can be edited after publishing, while `latest.json` currently
  contains only a short label. Use its notes as a fallback; a notes request
  failure must not block installation. Render Markdown through `ChatMarkdown`.
  Clear failed results when the dialog closes so reopening retries; keep successful
  results cached. A failed response must not trigger a retry loop while open.
  Strip the trailing `### 下载安装` section (and its preceding separator) appended
  by the release workflow from both fetched and fallback notes; leave the actual
  GitHub Release unchanged. If nothing remains, show the existing empty state.
- Keep the update dialog's header, release-notes toolbar and install footer outside
  the scroll region. Use a viewport/safe-area-bounded grid with a `minmax(0, 1fr)`
  notes row; only the notes region scrolls, with `overscroll-contain`.
  Give the named notes region `tabIndex={0}` and visible keyboard focus so WebKit
  users can scroll even when the Markdown contains no links or controls.
  Do not wrap the Markdown in another bordered card.
- `installUpdate()` in the error state rechecks for updates before another install
  attempt. The check closes the previous `Update` handle, including installer
  bytes retained after an installation failure. Do not download again on that
  same handle: the updater replaces its bytes reference without freeing the old
  resource. After rechecking succeeds, the user can start installation again.
- Download percentages come from updater byte events. If `contentLength` is
  absent, show downloaded bytes and indeterminate progress, not a guessed
  percentage. Use native `progress` and `output` elements.
- This dialog is desktop-only. Keep WebUI's existing PWA toast and refresh
  update flow unchanged; do not invoke the native updater from the browser.

## Copy

- User-facing strings are Simplified Chinese (`"复制"`, `"重试"`, …), matching the
  existing UI. Keep code identifiers and comments in English.

## File and Session Path References

- `SessionMentionProvider` derives the catalog from the existing project/session
  index. `SessionMentionScope` filters by exact `connection.id`, not transport
  type; same-connection cross-project references are allowed. The lazy-loading
  `ChatPageLoadingFallback` also needs the session connection scope so its enabled
  composer and first-message preview resolve the same references as `ChatPage`.
- `readChatMentionDraft` / `writeChatMentionDraft` in `src/lib/chat/chat-mentions.ts`
  keep mixed file/session references as trailing ordinary `@path` lines in the
  draft/submission string, preserving insertion order and deduplicating picks.
  Session values still use `sessionMentionValue` and resolve against the scoped
  catalog. Do not read or inject conversation content, add a second conversation
  store, or serialize titles instead of paths.
- Completed project file picks use quoted project-relative paths, e.g.
  `@"src/index.ts"`, including paths without spaces. Uploaded files instead use
  the server-returned absolute `.../attachments/<canonical-16-byte-base64url-id>/<name>`
  path in the project's environment, including Windows/UNC paths. The shared
  `fileMentionPath` parser recognizes both forms so chips, input history, cleanup,
  search and sent messages agree. This distinguishes a chip from a still-editable
  unquoted `@src` query without separate draft metadata. Empty/incomplete quotes,
  unrelated absolute paths, tilde paths and old inline mentions remain text.
  Resolve known sessions first so a quoted session path never becomes a file.
- Keep the native textarea for body editing. `FileMentionBadge` and
  `SessionMentionBadge` share `PathMentionBadge`: compact icon + name chips in
  the same wrapping row before the textarea, not a separate attachment row.
  Both sent/history user messages and Skill instructions use the default badge
  with a tappable path popover. Unknown/deleted absolute session paths remain
  visible as ordinary text.
- `tests/unit/chat-mentions.test.ts` covers mixed-reference round-trips, plain-text
  query preservation, deletion and slash-command submissions. Run the browser
  fixture `/tests/browser/chat-mentions.html` through Vite for desktop + 320px WebUI
  selection, path popovers, keyboard/mobile Backspace and sent-message rendering.
  Its search regression also checks file-chip/body same-name hits in visible
  order, next/previous navigation, session titles and compact/expanded Skill
  instructions; hidden paths and controls must not count as matches. Pure search
  projections are covered by `tests/unit/chat-message-search.test.ts`. Require
  `document.body.dataset.testStatus === "passed"`.
- Composer chips use `--pilo-composer-line-height`
  (`max(1.75rem, readingFontSize × 1.6px)`) for their geometry. The textarea uses
  `leading-[normal]` (native font leading, **not** Tailwind's `leading-normal`
  multiplier of 1.5) and symmetric block padding of
  `max(0px, (var(--pilo-composer-line-height) - 1lh) / 2)` to align its first line
  without inflating its text line-height. WebKit paints a trailing blank-line
  caret at the full line-height, so do not restore chip-height leading on the
  textarea. Reducing the multiplier only reduces the jump; it does not remove
  the mismatch between font-height text carets and line-height blank carets.
  The browser fixture requires native leading, checks finite autosizing and
  covers trailing/repeated newlines. Verify actual caret painting in WebKit:
  Chromium/style assertions alone missed this bug. Native leading removes the
  inflated caret, though WebKit can retain a 1 CSS px native difference between
  text and blank-line carets; do not claim pixel equality from a style assertion.
  Align chips by **text baseline**, not
  by box center: the compact chip label carries
  `leading-(--pilo-composer-line-height)`, the chip's flex containers use
  `items-baseline` (the icon stays `self-center`), and the wrapping row uses
  `items-baseline`. Centering the chip box instead leaves the smaller `text-xs`
  chip text ~1.5px above the reading-size body baseline because the font sizes
  differ. Fixed `h-7`/`items-center` chips beside independently scaled reading
  text drift vertically. Mobile keeps its 16px font-size floor but must not
  override the chip line-height or re-couple textarea leading to it; retain the
  separate coarse-pointer 44px hit target. The browser fixture compares the chip label baseline with the first
  text-line baseline for empty, single-character and multiline drafts. Measure
  that baseline with a zero-height inline DOM marker and allow at most 1 CSS px
  of native rounding; canvas font-bound estimates can falsely fail with native
  leading and independently scaled UI/reading fonts. Check independent UI/reading
  sizes and both pointer modes.
- Textarea autosizing keeps a whole-pixel minimum from `rows × lineHeight` plus
  padding/borders for both empty and non-empty text. Computed `line-height: normal`
  is not numeric: measure the native row box with `height: auto` and no CSS
  minimum on a hidden, absolutely positioned textarea clone in the same parent.
  Never remove the live textarea's minimum to measure native leading: its
  temporary shrink expands the adjacent chat viewport, and Chromium clamps
  `scrollTop` before the size is restored, producing a few-pixel rebound on
  streaming renders even though final DOM heights are unchanged. Keep the probe
  out of layout and the accessibility tree, remove duplicate IDs/names, and
  remove it immediately after measurement. Measure content `scrollHeight` on the
  same clone at the live textarea's computed width, with vertical overflow hidden
  and the placeholder cleared. Set the clone's value only after measuring native
  row height. Never reset the live textarea to `height: auto`, even with its CSS
  minimum preserved: a tall draft still temporarily collapses, clamps bottom
  scroll offsets, and can flicker on every keystroke. Only write the final height
  and overflow to the live textarea. Do not replace native leading with
  a multiplier just to make `parseFloat` work. Integer `scrollHeight` must not
  shrink the minimum on the first character and shift the inline chips. When
  verification is authorized, replay overflowing text in plain and virtualized
  chats at UI sizes 14/15 and check scroll offsets, not only settled heights.
- With a collapsed caret at body offset 0, Backspace removes the last reference
  atomically; elsewhere, text deletion and selection stay native. Handle mobile
  `beforeinput` / `deleteContentBackward` as well as keyboard Backspace, without
  intercepting IME composition or allowing changes while the composer is disabled.
- Composer suggestion/caret operations use visible body text; submission creation,
  input-history cursor validation, queues and recovery must use the full string.
  Append reference lines after the body so slash commands retain their prefix.
  `createChatSubmission` in `src/lib/chat/chat-submission.ts` ensures an ASCII space
  separates a slash-command name from following text: Pi splits Skill/extension
  names on a literal space, not arbitrary whitespace. Submit `/skill:foo` plus a
  reference as `/skill:foo \n@path`, not `/skill:foo\n@path`. Do this only at
  submission creation, never during draft editing (which would move the caret).
  Preserve existing spaces, bare commands and ordinary messages; keep multiline
  instructions intact and add the command separator before their first newline.
- A new `@` starts on the file category. Tab cycles categories without entering
  results; typing or Down enters results, where Tab/Enter completes. Up from the
  first result returns to categories. Empty results must not swallow submission
  of uncatalogued slash commands or ordinary text.
- Switching `@` categories changes filtering only: keep the file trigger/query
  active so existing and in-flight results survive without clearing or refetching.
  Reuse the panel DOM; list height follows its contents with a viewport-bounded
  maximum, not a fixed height. Show the Tab-switch hint beside the categories
  only while category navigation is active; in results, Tab completes instead.
- Only the desktop provider enables pointer dragging. Recheck connection and
  catalog membership on insertion; never enable native HTML5 dragging or touch
  drag on the WebUI. Keep existing project sorting and row action buttons intact.
- Mobile uses clickable categories/results, 44px coarse-pointer targets, a
  viewport-bounded results list, and a tappable path popover rather than hover.
