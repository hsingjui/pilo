# Native desktop UI

- One named component per kebab-case `.tsx` file. Import directly from `desktop/ui`.
- Wrap `nsh/base` behavior; keep application state and copy in callers. Use only
  native props, not React/DOM props (`class`, not `className`; no `asChild`).
- Match `src/ui` variants and geometry with theme-token Tailwind classes. Keep
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
- Fixtures and `nsh/test` coverage live in `desktop/tests/ui-*`. Check headless
  behavior and native macOS behavior separately; headless checks do not draw.
- Popover defaults to center (like React); triggers near a window edge must pass `align="start"`.
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
