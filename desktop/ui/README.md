# Native desktop UI

- One named component per kebab-case `.tsx` file. Import directly from `desktop/ui`.
- Wrap `nsh/base` behavior; keep application state and copy in callers. Use only
  native props, not React/DOM props (`class`, not `className`; no `asChild`).
- Match `web/ui` variants and geometry with theme-token Tailwind classes. Keep
  hover, active, disabled and keyboard-only focus feedback native.
- Resolve compound `styleVars` through the shared `theme-style` helper and apply
  them as inline styles; `token()` is for `cssVars`, not compound shadows.
  When switching themes, pair `setTheme({ cssVars: theme.cssVars })` with
  `setStyleTheme(theme.styleVars)`; pair both with `null` to restore Lody.
  The helper follows light/dark appearance with the same fallback order as NSH.
- Input/Button/Switch/Tab/Select compose focus rings and their base shadow in native `focusVisibleStyle`;
  caller state styles win. `nsh/test` checks composition and keyboard focus, but
  rendered rings require native screenshot verification (shadow styles are not exposed).
- Compose icons as children. Icons default to 16 points and the nearest
  `Foreground` context (provided by Button), or the foreground token outside it.
  An explicit icon color overrides the context. An icon without an
  accessibility label is decorative; icon-only controls need a control label.
  Icon and Spinner are canvases: a `text-*` class does not color them; pass
  `color={token(...)}` or provide `Foreground`.
- `MenuItem` draws its `icon` muted (`destructive` for destructive items), as
  React's menu icon slot; callers pass no icon color. Submenu chevrons are muted.
- `createHover` (`hover.ts`) tracks the pointer for icon foregrounds that a
  `hover:` class cannot reach; spread `hover.props` on the view.
- `StateView`/`EmptyState`/`ErrorState` (`state-view.tsx`) match React's
  `web/ui/state-view.tsx`; callers pass the copy (title, retry label).
- App-wide toasts (copy results, settings feedback, fork notices) go through
  `AppToaster`/`showToast` in `app/app-toasts.tsx`, shown top center as
  React's Sonner. Fixtures that render a pane alone provide their own
  `AppToaster.Provider` and `AppToastStack`.
- Fixtures and `nsh/test` coverage live in `desktop/tests/ui-*`. Check headless
  behavior and native macOS behavior separately; headless checks do not draw.
- Popover defaults to center (like React); triggers near a window edge must pass `align="start"`.
- Spinner draws Lucide LoaderCircle at 24pt by default (or `class` size / `size`)
  and rotates with native `animate-spin` (1000ms linear, infinite), without JS
  frame callbacks. Unlike React's WAAPI wall-clock anchor, late-mounted spinners
  start at their own phase: nsh 0.6.0 clamps JS style `animationDelay` to zero
  or above and exposes no absolute keyframe start time. Stroke color follows
  `Foreground` or `color`, not arbitrary SVG `currentColor` CSS; no DOM/WAAPI API
  is exposed. Native keyframes respect reduced motion (React's unqualified
  `animate-spin` does not). Native macOS window captures confirm rotation keeps
  running through the fixture's 1.5s JS block; the old JS clock froze. The fixture
  supports external screen capture without a JS-driven screenshot call.
- Skeleton is decorative, using the line/strong tokens and a per-bone native
  gradient sweep (58%, 1.35s); reduced motion removes the sweep. Callers own sizes
  and accessible loading announcements. The native animation graph scales the
  sweep with layout without restarting its phase. Native captures verify the
  sweep continues through a 1.5s JS block and redraws its foreground gradient
  after light-to-dark appearance changes without remounting. Canvas draw reads
  theme tokens in a reactive effect; `nsh/test` cannot inspect recorded gradient colors.
- Checkbox is a compact 16pt control with a 14pt mark. Use native `checked`,
  `indeterminate` and `onChange({ checked })`, or `defaultChecked` for local state.
  Labels stay outside; give the control an `accessibilityLabel`. Invalid styling
  uses `invalid`; nsh/base does not expose an invalid accessibility state for
  Checkbox, so callers must include validation context in the label. Marks use `primary-foreground` or
  `indicatorColor`, not arbitrary SVG `currentColor` classes. Keyboard focus
  composes a 3pt ring with the small shadow; rendered rings need native screenshots.
  Its native shadow transition is stretched to 2s by the fixture's block probe;
  the component keeps the standard transition duration.
- Textarea is a shadowless multiline field, unlike Input's 80pt-minimum multiline
  mode. `rows` defaults to two (58pt); positive row counts use the standard 20pt
  line height with 8pt vertical padding and a 1pt border. Invalid counts fall back
  to two. Caller classes/styles can override height; custom typography needs a
  matching caller height. Native Input has no browser drag-resize handle or
  intrinsic CSS rows. Autosizing stays caller-owned via `onContentSizeChange`,
  as in the React composer's separate resize hook; the fixture shows growth,
  shrinkage and a cap. Give each field an `accessibilityLabel`. Rendered focus
  rings and placeholder/foreground colors are verified with native screenshots.
  macOS native typing drops the requested 20pt leading to the font's ~17pt,
  unlike initialized text and React; explicit inline `lineHeight: 20` does not
  restore it. Box/rows geometry remains unchanged. This SDK typing-attributes
  mismatch is verified only by native screenshots, not `nsh/test` view styles.
- Command uses native `items`, query callbacks and slots instead of cmdk child
  components. It supplies the search icon, row/group/shortcut/empty styling;
  callers own empty copy, selection actions and loading indicators. Native
  filtering is case-insensitive label/keyword substring matching, not cmdk's
  fuzzy scoring; use `filterable={false}` for caller-ranked results (as Pilo's
  React palette already does). Native arrows wrap at the ends; cmdk defaults
  to stopping. Escape clears a nonempty query, then calls `onCancel`; cmdk's
  containing Dialog closes immediately instead. Compose Command inside
  CommandDialog and wire `onCancel` to the caller's open state. CommandDialog
  matches the 640pt, min(560pt, 72vh), 12%-top container without altering Dialog.
  Explicit `separator` adds section rules; default groups have none. Custom
  `renderItem` replaces row content, keeping native `group-focus:` styling.
  Native sections are flat rows with a shared 4pt list inset, not separately
  padded groups (8pt less space between sections). The inner scroll view has no
  public scrollbar-look prop, so overflow retains its platform indicator rather
  than ScrollArea's themed thumb.
  Components are static; live appearance captures verify the theme colors.
- Toast/ToastStack wrap native presentation; callers own a `ToastManager`
  (re-exported from `toast-stack`). Push with `{ timeout: durationInMs }` for
  auto-dismiss; omit timeout for a persistent toast. Advance on a timer, pausing
  while `onExpandedChange` reports expansion, and render `visible(limit)` oldest
  first with stable `Each` keys and each entry's `transitionStatus`. Wire
  `onDismissRequest` to `dismiss(id)` and stack `onCancel` to the newest toast.
  Place the stack in an `Overlay` at its matching edge; dispose the manager and
  timer on cleanup. See `ui-toast-fixture.tsx` for a complete lifecycle example.
  Variants match Sonner: neutral surfaces with semantic success/info/warning/error
  icons. `closeLabel` lets callers localize the close control.
- Place `Scrollbar` beside a `Scroll`/`List`, pass its ref as `scroll`, and turn
  the platform indicator off with `scrollbar={false}`. The default reveals on
  hover/scroll; `mode="always"` still hides when content fits. `axis="horizontal"`
  uses the compact horizontal track. `scrollbarLook(axis)` exposes the same
  classes for per-view built-in bars (`scrollbar={{ vertical: scrollbarLook() }}`).
  `nsh/test` cannot inspect native animated opacity or thumb geometry; verify
  show/hide and thumb position in native screenshots, not static style snapshots.
