---
version: alpha
name: Pilo
description: A quiet desktop workbench for the Pi coding agent - cool grey chrome that stays out of the way, one scarce accent that carries every meaning in the app, and a text contrast floor calibrated against the surface each token actually renders on.

colors:
  # Lody Light (default `:root`)
  background: "hsl(0 0% 100%)" # the page. Only the page.
  surface: "hsl(220 23.1% 97.5%)" # card, sidebar, code block - one step off the page
  foreground: "hsl(225 7.1% 11%)" # all primary text
  foreground-muted: "hsl(220 7.5% 39%)" # card + sidebar body text, icon glyphs
  muted: "hsl(216 17.2% 94.3%)" # inert fill: disabled field, tab strip, chip bg
  muted-foreground: "hsl(220 8.9% 43.8%)" # secondary and placeholder text
  hover: "hsl(225 15.4% 94.9%)" # every hover fill in the app
  border: "hsl(222.9 16.3% 91.6%)" # layout divider, resting surface edge
  border-strong: "hsl(222 14.7% 86.7%)" # outline of an editable control
  field: "hsl(0 0% 100%)" # fill of an editable control
  primary: "hsl(219.7 82.2% 54%)" # the only accent: action, selection, running
  primary-hover: "hsl(218.6 65.3% 47%)" # pressed fill for the primary action
  primary-foreground: "hsl(0 0% 100%)" # text on any solid accent
  ring: "hsl(219.7 82.2% 64.7%)" # focus ring - visible, never carries text
  secondary: "hsl(216 12.2% 92%)" # second-rank button fill
  destructive: "hsl(355.8 71.8% 47.3%)" # irreversibility only
  success: "hsl(137.2 66% 30%)" # finished, connected, added
  warning: "hsl(24.9 58.9% 41%)" # attention without failure
  syntax-keyword: "hsl(230.9 60.9% 58.2%)"
  syntax-string: "hsl(10.4 38.3% 47.8%)"
  syntax-number: "hsl(191.2 49.2% 36.3%)"
  syntax-comment: "hsl(120 7.3% 41%)"
  syntax-function: "hsl(95.8 39.9% 34.8%)"
  syntax-variable: "hsl(30.6 41.9% 40.6%)"
  syntax-title: "hsl(172 51.3% 32.5%)"
  syntax-builtin: "hsl(50.2 72.9% 29.5%)"

  # Lody Dark = bundled Vesper (`.dark`)
  background-dark: "hsl(0 0% 6.3%)"
  surface-dark: "hsl(0 0% 8.6%)"
  foreground-dark: "hsl(0 0% 100%)"
  muted-dark: "hsl(0 0% 13.7%)"
  muted-foreground-dark: "hsl(0 0% 62.7%)"
  hover-dark: "hsl(0 0% 15.7%)"
  border-dark: "hsl(0 0% 15.7%)"
  field-dark: "hsl(0 0% 11%)"
  primary-dark: "hsl(27.1 100% 80%)"
  primary-hover-dark: "hsl(26.9 100% 82.9%)"
  primary-foreground-dark: "hsl(0 0% 0%)"
  ring-dark: "hsl(27.1 100% 80%)"
  destructive-dark: "hsl(0 100% 75.1%)"
  success-dark: "hsl(151 60% 52%)"
  warning-dark: "hsl(50 100% 72%)"
  syntax-keyword-dark: "hsl(0 0% 62.7%)"
  syntax-string-dark: "hsl(164.1 100% 80%)"
  syntax-comment-dark: "hsl(0 0% 54.5%)"

typography:
  display:
    fontFamily: Inter
    fontSize: 30px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: -0.025em
  headline:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: -0.025em
  title:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: -0.02em
  body:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: 0em
  label:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0em
  code:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0em

rounded:
  xs: 2px
  sm: 4px
  md: 6px
  lg: 8px
  xl: 12px
  full: 999px

spacing:
  "1": 4px
  "2": 8px
  "3": 12px
  "4": 16px
  "6": 24px
  "8": 32px

components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 16px
    height: 36px
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 16px
    height: 36px
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 16px
    height: 36px
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 16px
    height: 36px
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 16px
    height: 36px
  button-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 16px
    height: 36px
  field:
    backgroundColor: "{colors.field}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 12px
    height: 36px
  badge:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: 10px
    height: 20px
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground-muted}"
    rounded: "{rounded.lg}"
    padding: 24px
  sidebar-panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground-muted}"
    rounded: "{rounded.xl}"
    padding: 2px
  sidebar-row:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 8px
    height: 28px
    width: 100%
  chat-composer:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.xl}"
    padding: 6px
  composer-send:
    backgroundColor: "{colors.foreground}"
    textColor: "{colors.background}"
    rounded: "{rounded.full}"
    height: 28px
    width: 28px
  menu-surface:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.xl}"
    padding: 4px
    width: 220px
  menu-item:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: 12px
    height: 32px
    width: 100%
---

# Pilo Design System

## Overview

**Creative North Star: The Quiet Workbench.** Pilo is a place where work happens, not a place that announces itself. Chrome recedes until the only loud things on screen are the conversation and the code — which is exactly why the surfaces are near-white and cool-grey, why row actions are invisible until you hover the row, why shadows are measured in single-digit percent alpha, and why exactly one accent hue is allowed to exist.

Two themes, one structure. Light is **Lody Light**: white paper, `#f7f8fa` panels, cool grey text, and a blue accent deliberately darkened to `hsl(219.7 82.2% 54%)` so white text on it reads 4.8:1. Dark is the bundled **Vesper**: a `#101010` canvas, grey ladder, and a warm amber accent `hsl(27.1 100% 80%)` carrying *black* text. Dark is not the light palette inverted — it is a second palette that happens to share the same role names.

The personality comes from three places, and none of them are decoration: **restraint** (one accent, four surface steps, one control height), **the two typographic voices** (Inter for chrome, JetBrains Mono for anything the user might paste into a terminal), and an **evidence-based contrast discipline** — every text token in `src/index.css` carries a comment recording the ratio it was calibrated to against the surface it actually renders on, 12px monospace included.

## Colors

Tokens live as raw HSL triplets in `:root` / `.dark` in `src/index.css`, mapped to Tailwind utilities in `@theme inline`. Components reference the *roles* (`bg-background`, `text-muted-foreground`), never the values — which is what lets both themes be correct without a single `dark:` color override in application code.

**The accent is scarce, and that is the whole system.** `primary` appears on four things and nothing else: the primary action, the focus ring, the active sidebar selection, and a running state. A screen with two blue things in it is a screen that has not decided what it is about.

- **Light accent.** `primary: hsl(219.7 82.2% 54%)` — Lody's `#5B8DEF` pushed down one step so white text clears AA. The ring is the *undarkened* `hsl(219.7 82.2% 64.7%)`, because a focus ring must be visible against the page rather than carry text — two jobs, two lightnesses.
- **Dark accent.** `primary: hsl(27.1 100% 80%)` with `primary-foreground: hsl(0 0% 0%)`. The theme flips the foreground, not the accent. Never put white text on the amber.
- **Surface ladder.** `background → surface → muted → hover`. Light spreads it wide (`100% / 97.5% / 94.3% / 94.9%`); dark compresses it (`6.3% / 8.6% / 13.7% / 15.7%`) because `#101010` leaves very little room below. Note that dark's `muted` is deliberately one step off the canvas — at zero step, selection and hover are invisible.
- **Borders do not carry state.** `border` is for dividers and resting surface edges, `border-strong` for the outline of an editable control. State is expressed with the focus ring or a fill change, never with a border color.
- **Status colors are separate from the accent.** `success` (`137.2 66% 30%`) and `warning` are *darker and duller* than `primary` in light mode, so a status chip never competes with the action next to it. In dark, `warning` departs from Vesper entirely — 50° yellow instead of 27° orange — because a warning sitting beside an amber accent must not read as the same signal.
- **Code has its own surface.** `code-surface` equals `surface` and `code-added`/`code-removed` are literally `success`/`danger`, so diffs inherit the status semantics for free. The light theme keeps all eight syntax hues; dark collapses to three (grey keyword, mint string, grey comment) and lets number/function/title/builtin fall to the amber, because Vesper is a one-accent theme and pretending otherwise produces rainbow soup.

## Typography

Two families, both self-hosted via `@fontsource`, both Latin-subset with a deliberate CJK fallback chain (`Noto Sans SC`, `PingFang SC`, `Microsoft YaHei`) because the UI copy is Chinese and Latin-only line-height assumptions break on full-width glyphs.

**Weight carries hierarchy; size mostly does not.** The interface runs almost entirely at 14px. Emphasis is `font-weight` 400 → 500 (control labels, menu items, row names) → 600 (titles). Only three sizes exist above body, and they belong to exactly three roles: 18px (sidebar brand), 24px (card title), 30px (empty-state hero). Nothing else gets to grow.

**Tracking tightens as size grows.** `-0.025em` at 24–30px, `-0.02em` at 18px, `0` at 14px and below. At 12px, negative tracking destroys legibility and is never used.

**Monospace marks "this is data".** JetBrains Mono at 12px with contextual ligatures on is used for code, file paths, shell commands, counts, keyboard shortcuts, and connection targets — anywhere the user might copy a literal string. It is not used for stylistic contrast. Body code runs at 1.5 line-height rather than the UI's 1.45, because code is read line by line.

**Inter is loaded at 400/500/600/700.** Nothing in the UI uses 700; it exists for markdown-rendered content inside a chat message.

## Layout

**The shell is a resizable split.** A sidebar panel and a main region, with a drag handle between them. The sidebar defaults to `292px` and moves within `240–480px`.

**The sidebar is a floating panel, not a column.** It sits `8px` from the top and bottom, `8px` from the left, `4px` from the right, and is drawn as `rounded-xl` + `border-sidebar-border/80` + `bg-sidebar` + `shadow-sm` + `p-[2px]` (`src/components/sidebar/app-sidebar.tsx:469`). This is the single most opinionated shape in the app: the navigation is a card resting on the canvas, and the gap around it is what makes the canvas read as a workspace rather than a window.

**The chat column is capped.** `max-w-[min(80%,52rem)]`, centered. Prose that runs the full width of a 4K window is unreadable, and a transcript is prose.

**Spacing is Tailwind's 4px grid, applied in three registers.** `8px` inside a control row (icon-to-label gaps), `16px` between groups of controls, `24px` for card padding. Anything outside those three numbers should be justified out loud.

**Control height is a small closed set.** `36px` (`h-9`) default, `40px` (`h-10`) large, `32px` (`h-8`) small, `28px` (`h-7`) dense toolbar rows, `20px` (`h-5`) chips and inline action buttons. A control that needs a height not on this list is usually two controls.

**Fixed widths where a number must not jump.** Config and connection popovers are `w-[248px]`, menus `min-w-[220px]`. Menu content changes as state changes; a menu that resizes as you move through it is a menu that feels broken.

## Elevation

**Shadow is a border substitute, not a light source.** Nothing in this interface is lit from above. The rule set is short:

1. **Resting surfaces get a border.** Shadow is optional and tiny — `shadow-xs` is `0 2px 4px / 5%`. If a card feels flat, the answer is a border or a surface step, not more shadow.
2. **Floating surfaces get a two-stop stack.** `shadow-panel` (`0 1px 2px / 8%` + `0 10px 30px / 10%`) and `shadow-popover` (`0 2px 6px / 10%` + `0 18px 50px / 14%`) each pair a tight contact shadow with a wide ambient one. Two stops, always — one shadow reads as a smudge, three reads as a mistake.
3. **Dark mode is not a no-shadow mode; it is a heavier-shadow mode.** `shadow-panel` in dark is `0 1px 1px / 35%` + `0 14px 44px / 55%` — roughly *four times* the alpha. Black on black needs an actual pool of darkness to separate two surfaces. Copying light's shadow values into dark produces flat, stuck-together panels.
4. **Menus have no border at all.** The edge is the first ring in a `boxShadow` stack: `0 0 0 1px color-mix(in oklab, hsl(var(--background)) 90%, hsl(var(--foreground)) 10%)` — a color derived from the live theme, so the edge stays exactly one step off the surface in both modes, and it costs no layout box (`src/ui/menu-styles.ts`).
5. **Never stack shadows from two different families** on the same element.

## Shapes

`rounded-xs 2px / sm 4px / md 6px / lg 8px / xl 12px / full`.

Radius is semantic, not whimsical:

| Radius | Role | Examples |
| --- | --- | --- |
| `md` 6px | **controls** | buttons, inputs, sidebar rows, chips, tabs |
| `lg` 8px | **containers** | cards, menu items |
| `xl` 12px | **floating surfaces** | sidebar panel, composer surface, menu surface |
| `sm` 4px | **inline dense actions** | hover-revealed row buttons, confirm chip's inner icon |
| `full` | **circular** | icon-only round buttons, the composer send key, the confirm chip |

**Concentricity is enforced by arithmetic, not by eye.** An inner radius must be smaller than its container's by at least the container's padding. The sidebar panel is `rounded-xl` with `2px` padding, so the rows inside it are `rounded-md` — never `rounded-xl` again. The composer is `rounded-xl` with `6px` padding, so its send key is `full` (a circle is always concentric) and its attachment button is `md`.

**Radius is the only softness in the system.** No glass, no backdrop blur as decoration, no gradients, no glow.

## Components

**Buttons.** Six variants on one base: `default`, `secondary`, `outline`, `ghost`, `destructive`, `link` — four sizes `default 36px`, `sm 32px`, `lg 40px`, `icon 36px square`. Every variant presses with `active:scale-[0.96]` at `--dur-1` — a 4% squash is the entire tactile vocabulary of this app, and it is enough. `shadow-sm` on the filled variants, `shadow-xs` on `secondary`/`outline`, nothing on `ghost`. `ghost` and `outline` share the same hover fill (`bg-hover`) so a toolbar of mixed variants still feels like one toolbar.

**The chat composer is the signature surface.** A `rounded-xl` box with a hairline border at `foreground/[0.10]` in light and `input-border/70` in dark, over `bg-background`. It has two states and they are the same box: resting, and focused — where only the *border* changes, to `ring/40`. No ring, no glow, no shadow, no lift. Inside it: a borderless transparent textarea (`min-h-12`, no focus ring of its own), a toolbar row, and a circular send key that is filled with `foreground` and inverted (`text-background`) so the single most-pressed control in the app is achromatic and never competes with the accent (`src/components/chat/chat-composer-frame.tsx`).

**Sidebar rows are 28px and silent until touched.** A `rounded-md` row with a transparent border that becomes visible on hover; all inline actions (rename, menu, delete) are `opacity-0 pointer-events-none` until `group-hover`. The row itself is a `div`, not a button, and the actions are independent buttons inside it — native nesting of interactive controls is invalid. The file carries an `oxlint-disable jsx-a11y/prefer-tag-over-role` for exactly this reason.

**Badges are 20px chips with four fills** plus two tinted status variants: `success` and `warning` use a `12%` tint fill with a `20%` border of the same hue and the *full-strength* hue as text. That is the only place in the system where a tint is used, and it is used for status so that status never looks like a button.

**Cards are `rounded-lg` + `border` + `bg-card` + `shadow-xs`**, padding `24px`, title at 24px/600. They are containers, not callouts: no accent left border, no colored header.

**Menu items are 32px minimum** with `rounded-lg`, a `12px` leading icon slot, and a trailing `ms-auto` slot at 12px monospace for shortcuts and counts. Focus and open-state both use `bg-hover` — the menu does not have a separate "selected" color, because in a menu hover *is* selection.

**Motion, in full.** The system animates only `color`, `background-color`, `border-color`, `opacity`, and `scale`. `--dur-1: 120ms` for hover, press, and focus; `--dur-2: 180ms` for entering surfaces; `--ease: cubic-bezier(0.2, 0, 0, 1)` everywhere. Nothing animates a layout property, and `prefers-reduced-motion` resets transitions globally.

## Named Rules

**The Scarce Accent Rule.** `primary` is permitted on exactly four things: the primary action, the focus ring, the active selection, and a running/active state. No accent headings, no accent borders, no accent icons, no accent chart lines. When a screen has two attention-grabs, delete one.

**The Calibrated Text Rule.** Every text token is chosen against the surface it actually renders on and must clear 4.5:1 *there* — 12px monospace counts as body text, not as decoration. `src/index.css` records the ratio in a comment beside each value (`220 8.9% 43.8%` → "4.6:1 on `#eef0f3`"). A new text token is not finished until its comment exists. When a background changes, every text token that touches it is re-checked.

**The Whole-Pixel Hit Area Rule.** Visual size may go below 24px; the hit area may not. Dense row actions are drawn at `20×20` and extended to `24×24` with `after:absolute after:-inset-0.5 after:content-['']` (`src/components/sidebar/rows.tsx:29-38`). The pseudo-element is not optional, and it is not a workaround — it is how a compact row stays compact and still passes a touch-target audit.

**The Two-Step Destructive Rule.** Destructive actions inside dense lists never open a modal and never fire on the first click. The first click swaps the control into a `rounded-full` chip reading "确认…" with a `20%` destructive border and `shadow-xs`; blur, pointer-leave, or Esc cancels it (`src/components/sidebar/rows.tsx:44+`). Deletion from a list is a mis-click waiting to happen, and the confirm state costs one row's width.

**The No-Transition-On-Theme-Switch Rule.** Theme changes add `.pilo-theme-switch` to `<html>` for one frame, applying `transition: none !important` to everything (`src/index.css:271-280`). Without it, every token in the document animates simultaneously and the whole window smears for 180ms. Theme switching must be instant, because it is a re-light, not a gesture.

## Do's and Don'ts

**Do**

- Reference semantic roles. Add a new `:root` **and** `.dark` pair together, in the same commit, or not at all.
- Start from the 4px grid, the 36px control height, and the `md`/`lg`/`xl` radius table before inventing a value.
- Ship a new screen in both themes before calling it done. The dark palette is not a filter over the light one, and dark-only bugs (invisible `muted` steps, light-alpha shadows) do not surface in light mode.
- Use `text-muted-foreground` for de-emphasized text rather than an opacity on `foreground` — opacity silently breaks the calibrated ratio.
- Reach for a border or a surface step to separate two surfaces in light mode, and a shadow in dark mode.

**Don't**

- Don't add a third accent hue. Two exist (`primary`, `destructive`) plus two status colors, and the scarcity is the design.
- Don't put a raw hex in a component. If a color needs to exist, it needs a token, and a token needs both themes.
- Don't animate layout properties. `transition-[width,height,margin]` is how this interface starts feeling cheap.
- Don't apply `shadow-sm` or heavier to signal "raised" in light mode; light mode separates with borders. Reserve real shadow for things that genuinely float.
- Don't reuse a light-mode shadow value in dark mode. Dark needs roughly 4× the alpha.
- Don't give a control inside an `xl` panel a radius larger than `md`.
- Don't reach for `rounded-full` on a rectangular control. Circles are for icon-only controls and the send key.
- Don't introduce a display size above 30px. There are three sizes above body text and there is no fourth.