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
- Compose icons as children. Icons default to 16 points and the nearest
  `Foreground` context (provided by Button), or the foreground token outside it.
  An explicit icon color overrides the context. An icon without an
  accessibility label is decorative; icon-only controls need a control label.
- Fixtures and `nsh/test` coverage live in `desktop/tests/ui-*`. Check headless
  behavior and native macOS behavior separately; headless checks do not draw.
