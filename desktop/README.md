# Pilo desktop (nsh)

## Built-in themes

From the repository root, run `pnpm desktop:generate:themes` after editing
`src/styles/lody-theme.css` or `src/styles/claude-theme.css`. The checked-in
`theme.json` (Lody) and `claude-theme.json` are complete themes; use
`pnpm desktop:generate:themes --check` to detect stale output.

- `cssVars` contains the tokens understood by nsh 0.6.0: colors, shared
  numbers/lengths and font families. Pass `{ cssVars }` to `setTheme`.
  Absolute `calc()`/ `max()` lengths are reduced at 16 points per rem.
  There is no generic `radius` in the source themes: use the named Pilo radius
  tokens, or leave the built-in nsh radius at its default.
- `styleVars` retains resolved source CSS values that `token()` cannot expose,
  including shadows, motion, shorthand values and layout-dependent math.
  Use the relevant theme/appearance's values with explicit component styles
  where supported; do not pass this map to the native token API.

## Icons

Run `pnpm desktop:generate:icons` to refresh the Canvas data from the named
`lucide-react` icon imports in `src/`. Add `--check` to detect stale output.
The generated `app/lucide-icons.json` uses the original export names, including
aliases, without bundling React or Lucide.

Each icon has its original square viewbox `size` and ordered `paths`.
Scale the Canvas context from that viewbox, construct `new Path2D(d)` for each
path, fill entries marked `fill: true`, and stroke every path. Lucide defaults
to a 2-unit stroke and round caps/joins. The source data is covered by
`app/Lucide-LICENSE`.
