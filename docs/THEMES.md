# Theme customization

Create and manage custom themes from the **Theme** (palette) button in the
connected WebUI. Custom themes are named sets of token overrides that change
Pilo's interface without changing Pi's terminal theme or agent behavior.
The native desktop settings offer only **Lody** and **Claude**, but the desktop
also renders the active custom theme saved on the Host.

- [Quick start](#quick-start)
- [Save, switch and recover](#save-switch-and-recover)
- [Writing a custom theme](#writing-a-custom-theme)
- [Customization points](#customization-points)
- [Troubleshooting](#troubleshooting)
- [Startup and safety](#startup-and-safety)

## Quick start

1. In the connected WebUI, open **Theme** using the palette button.
2. Under **Custom tokens**, enter a **Theme name**. Use **Filter tokens** to
   find the names below, then enter each value in its field. You do not paste
   a stylesheet or a JSON file into the editor.
3. Choose **Save and apply**. The saved theme appears under **Theme style**
   next to **Lody** and **Claude**.
4. Use **Color mode** to check **Light** and **Dark**. Check text contrast,
   hover, keyboard focus, and the chat composer in both modes.

| Token                  | Light               | Dark                    | Value (both modes) |
| ---------------------- | ------------------- | ----------------------- | ------------------ |
| `primary`              | `hsl(14 61.7% 47%)` | `hsl(15.9 62.4% 59.6%)` |                    |
| `primary-foreground`   | `#fff`              | `hsl(0 0% 8.2%)`        |                    |
| `pilo-composer-radius` |                     |                         | `1rem`             |

Custom themes use Lody as the base, regardless of the previously selected theme.
A light color override also applies in dark mode unless you set a dark override.
A token with no overrides keeps the preset values.

## Save, switch and recover

- **Edit:** select a saved theme under **Theme style**, change its tokens, then
  choose **Update and apply**. Typing alone does not preview or save changes.
- **Create a variation:** change the name and save. Names are trimmed; an existing
  name updates that entry instead of creating a duplicate.
- **Cancel:** discards editor changes and restores the currently applied custom
  tokens and saved name, if any. It does not undo an already saved update.
- **Switch back:** select **Lody** or **Claude** to stop applying custom tokens.
  Saved custom themes remain available for later selection.
- **Delete:** use the theme's trash button and confirm. This removes the saved
  entry, but the applied tokens stay active until you switch themes. To recover
  the default appearance, select **Lody** rather than just deleting.
- **Share or back up:** record the token names and values, including the light
  and dark fields. There is no file import, export, or version history.

Themes are stored on the desktop Host in SQLite; browser storage is a startup
cache, not the source of truth. A theme change in WebUI updates the active theme
for the desktop and all connected WebUI clients. In **Follow system** mode,
each client resolves light or dark from its own device preference. Theme choices
are not per-project or per-connection.

## One contract, built-in and saved themes

Lody and Claude are built-in token presets, not separate component
implementations. The WebUI editor exposes a validated catalog shared with the
native desktop. See the [desktop theme notes](../desktop/README.md#custom-themes)
for the token format and native rendering limits.

WebUI sources:

- [`web/styles/lody-theme.css`](../web/styles/lody-theme.css): complete defaults
  and dark-mode values.
- [`web/styles/claude-theme.css`](../web/styles/claude-theme.css): Claude's
  light/dark overrides of those tokens.
- [`web/styles/theme-components.css`](../web/styles/theme-components.css): shared
  component rules; no family selectors.
- [`web/index.css`](../web/index.css): shared Tailwind mappings, chat styles and
  responsive rules.

The only Claude-family selectors choose token values on the document root.
No component, interaction or boot-shell rule checks that family. New built-in
styling differences must be expressed through this contract, so custom themes
can express the same differences.

## Writing a custom theme

Enter values in the fields shown by the WebUI editor. Search for each token
without the CSS `--` prefix. Colors take complete values such as `#f0f0ef`,
`rgb(240 240 239)`, or `hsl(14 61.7% 47%)`; some tokens require opaque colors.
Lengths take non-negative `px` or `rem` values, such as `0px` or `1rem`.
Colors have separate light and dark fields; other values apply to both modes.
The editor does not accept selectors, `var()` references, or arbitrary CSS.

The rest of this guide uses CSS names and examples to explain the WebUI presets.
These are source references, not snippets to paste into the editor. When
adapting an example, look up each name in **Filter tokens** and enter a supported
literal value. Some source variables (such as composite shadows and padding
shorthand) are not available in the shared editor. Grouped names such as
`--pilo-sidebar-margin/height/width` and `--primary*` are not literal names.

For example, an edge-attached sidebar is configured with values, just as in
the built-in Claude theme:

```css
:root {
	--primary: 14 61.7% 47%;
	--primary-foreground: 0 0% 100%;
	--pilo-sidebar-margin: 0;
	--pilo-sidebar-height: 100%;
	--pilo-sidebar-width: 100%;
	--pilo-sidebar-border-width: 0 1px 0 0;
	--pilo-sidebar-border-color: hsl(var(--sidebar-border) / 0.6);
	--pilo-sidebar-radius: 0;
	--pilo-sidebar-padding: 0.5rem;
	--pilo-sidebar-shadow: none;
	--pilo-mobile-sidebar-radius: 0;
	--pilo-composer-radius: 1rem;
	--pilo-composer-background: hsl(var(--card));
	--pilo-menu-item-height: 2.25rem;
	--pilo-menu-touch-height: 2.75rem;
}

:root.dark {
	--primary: 15.9 62.4% 59.6%;
	--primary-foreground: 0 0% 8.2%;
	--pilo-composer-border: hsl(var(--input-border) / 0.7);
}
```

This source example configures part of the appearance, not the complete Claude
palette. The editor lists the subset of preset values that can be customized
across both clients. If a legacy CSS theme has unconverted rules, the editor
shows them under **Unconverted CSS**. Review that list before saving: those parts
are not carried forward as tokens.

## Desktop and mobile dimensions

Shared controls use desktop tokens named `--pilo-*` and independent mobile tokens
named `--pilo-mobile-*`. For example, `--pilo-button-height` controls desktop
buttons, while `--pilo-mobile-button-height` controls mobile buttons. Leaving a
mobile token unset preserves its preset default, not a custom desktop value.
Colors, shadows, font preferences and motion remain shared.

Mobile dimensions apply to WebUI at widths up to 1023px (matching its navigation
layout), and to devices matching `(hover: none) and (pointer: coarse)`. Wide WebUI
with a mouse uses desktop dimensions. Menus and dialogs rendered in portals use
the same device selection; CSS responds to resizing without reloading or syncing
a different theme back to the Host.

The following suffixes support both prefixes. Slash-separated suffixes list
separate variables, not a literal token name:

| Component             | Suffixes after `--pilo-` or `--pilo-mobile-`                                                                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Radius scale          | `radius-xs`, `radius-sm`, `radius-md`, `radius-lg`, `radius-xl`                                                                                                                                          |
| Messages and composer | `bubble-radius`, `composer-radius`                                                                                                                                                                       |
| Floating surfaces     | `floating-radius`, `context-details-radius`, `menu-radius`                                                                                                                                               |
| Menu                  | `menu-padding`, `menu-item-height`, `menu-item-radius`, `menu-item-gap`, `menu-item-padding`, `menu-item-content-gap`                                                                                    |
| Select                | `select-padding`, `select-gap`, `select-item-height`, `select-item-radius`, `select-item-padding`, `select-trigger-padding`                                                                              |
| Buttons               | `button-height`, `button-sm-height`, `button-lg-height`, `button-icon-size`, `button-padding`, `button-sm-padding`, `button-lg-padding`, `button-gap`                                                    |
| Fields                | `field-height`, `input-padding`, `textarea-padding`                                                                                                                                                      |
| Command/search        | `command-input-height`, `command-input-padding`, `command-item-height`, `command-item-padding`, `command-item-gap`                                                                                       |
| Dialog                | `dialog-padding`, `dialog-gap`                                                                                                                                                                           |
| Composer layout       | `composer-padding`, `composer-gap`, `composer-input-height`, `composer-toolbar-gap`, `composer-control-size`, `composer-attachment-width`, `composer-attachment-hit-size`, `composer-run-config-padding` |

Padding tokens accept CSS shorthand. Item-height tokens are minimums; button and
field heights configure their default boxes. General mobile controls retain a
44px floor. The composer's compact toolbar retains its existing 40px control
minimum, with a 44px attachment hit area and separate attachment gutter width.
Explicit caller utilities still override component defaults: special compact
controls do not inherit the sizing of an unrelated generic button or field.

Mobile-only roles already have their own geometry: the drawer uses
`--pilo-mobile-sidebar-*`, its switch uses `--pilo-segment-*`, and run-config
bottom sheets use `--pilo-sheet-*`. Do not add a second `mobile-` prefix to these
roles. Sheet control/model minimum heights are `--pilo-sheet-control-height` /
`--pilo-sheet-model-height` (44px / 48px defaults), with
`--pilo-sheet-item-gap` between model rows. Heights are clamped to at least 44px.

For example, change several controls independently:

```css
:root {
	--pilo-button-height: 36px;
	--pilo-mobile-button-height: 48px;
	--pilo-field-height: 36px;
	--pilo-mobile-field-height: 48px;
	--pilo-menu-item-height: 32px;
	--pilo-mobile-menu-item-height: 48px;
	--pilo-menu-padding: 4px;
	--pilo-mobile-menu-padding: 8px;
	--pilo-composer-padding: 6px 8px;
	--pilo-mobile-composer-padding: 8px 12px;
	--pilo-composer-radius: 12px;
	--pilo-mobile-composer-radius: 16px;
}
```

The internal `--pilo-ui-*` aliases select these values for rendering. Set the
public desktop/mobile tokens, not these aliases: overriding an alias bypasses
device selection. Preset mobile item-radius formulas reference mobile padding
and outer radii, so their inset curves remain consistent after customization.

## Customization points

### Palette, typography and motion

- Canvas/surfaces: `--background`, `--foreground`, `--card`, `--popover`,
  corresponding `*-foreground`, `--border`.
- Actions/state: `--primary*`, `--button-*`, `--secondary*`, `--muted*`,
  `--hover*`, `--destructive*`, `--ring`, `--status-*`.
- Sidebar: `--sidebar-background`, `--sidebar-foreground`,
  `--sidebar-foreground-muted`, `--sidebar-hover*`, `--sidebar-selection*`,
  `--sidebar-border`, `--sidebar-ring`, `--sidebar-primary`.
- Fields/tooltips: `--input*`, `--switch-track`, `--tooltip-background`,
  `--tooltip-foreground`.
- Code/loading: `--code-*`, `--syntax-*`, `--skeleton-*`, `--scrollbar-*`.
- Corners: `--pilo-radius-xs/sm/md/lg/xl`, `--pilo-bubble-radius`,
  `--pilo-composer-radius`.
- Display heading: `--pilo-display-font-family`. Interface/reading/code font
  preferences remain independent and continue to take precedence for their roles.
- Interaction timing: `--dur-1`, `--dur-2`, `--ease`; preserve reduced-motion rules.

### Layout and selected rows

| Tokens                                                                                        | Effect                                                                                     |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `--pilo-sidebar-margin/height/width`                                                          | Floating versus edge-attached sidebar geometry                                             |
| `--pilo-sidebar-border-width/border-color/radius/padding/shadow`                              | Sidebar shape and elevation; border width accepts four sides                               |
| `--pilo-mobile-sidebar-radius`                                                                | Mobile drawer shape; accepts a full border-radius value                                    |
| `--pilo-mobile-sidebar-width/content-padding/header-height`                                   | Drawer width, content gutter and header minimum; width reserves 64px of dismissal backdrop |
| `--pilo-sidebar-project-height/project-padding/env-height/env-padding/row-gap`                | Desktop project/environment row density                                                    |
| `--pilo-mobile-project-height/project-padding/env-height/env-padding/row-gap/row-action-size` | Independent mobile row density and action size; 44px minimum                               |
| `--pilo-sidebar-session-gap`                                                                  | Desktop session spacing, including virtual lists; default `0.25rem`                        |
| `--pilo-mobile-session-gap`                                                                   | Independent mobile session spacing; default `0.25rem`                                      |
| `--pilo-sidebar-selected-border/background/foreground`                                        | Desktop selected session/project appearance                                                |
| `--pilo-project-selected-foreground`                                                          | Project selection text, including its separate dark-mode dimming                           |
| `--pilo-mobile-selected-background`                                                           | Mobile selected row fill                                                                   |
| `--pilo-mobile-confirm-selected-background`                                                   | Selected mobile row while confirming deletion                                              |
| `--pilo-mobile-selected-ring-width`                                                           | Mobile selection outline: `1px` or `0px`, not a boolean switch                             |
| `--pilo-conversation-max-width`                                                               | Shared desktop/session/WebUI reading measure; omit for device defaults                     |
| `--pilo-user-bubble-bg/border`                                                                | Complete CSS colors for user messages                                                      |

Mobile WebUI remains full-width below 640px. Keep drawer dismissal space,
safe-area padding and existing mobile touch targets; these are interaction
constraints, not family styling.

### Session row density

Desktop (including wide WebUI) and mobile navigation use separate tokens. Mobile
values keep their built-in defaults when omitted; they do not inherit desktop
density. These tokens affect session rows, not project/environment rows or other
controls.

| Desktop token                            | Mobile token                            | Effect and default                                                                             |
| ---------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `--pilo-sidebar-session-height`          | `--pilo-mobile-session-height`          | Minimum row height: `1.875rem` / `2.75rem`                                                     |
| `--pilo-sidebar-session-context-height`  | `--pilo-mobile-session-context-height`  | Minimum height with a project label: `3.125rem` / `3.5rem`; never below the regular row height |
| `--pilo-sidebar-session-padding`         | `--pilo-mobile-session-padding`         | CSS padding shorthand: `0.125rem 0.5rem` / `0.5rem`                                            |
| `--pilo-sidebar-session-context-padding` | —                                       | Desktop two-line row padding: `0.25rem 0.5rem`; mobile uses its regular padding                |
| —                                        | `--pilo-mobile-session-confirm-padding` | Mobile delete-confirmation row padding: `0 0.25rem 0 0.5rem`                                   |

Heights and gaps accept non-negative CSS lengths. Heights are minimums, not fixed
boxes: text and padding can grow the row. Mobile rows retain a `44px` minimum even
when the theme requests less; confirmation actions also keep their touch targets.
Virtual lists measure the rendered desktop row and its spacing, so custom heights
and padding do not depend on a hardcoded virtualizer gap.

For example, set each device's density without media queries:

```css
:root {
	--pilo-sidebar-session-height: 32px;
	--pilo-sidebar-session-padding: 4px 8px;
	--pilo-sidebar-session-gap: 4px;

	--pilo-mobile-session-height: 52px;
	--pilo-mobile-session-padding: 8px 12px;
	--pilo-mobile-session-gap: 8px;
}
```

### Composer, fields and buttons

| Tokens                                           | Effect                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| `--pilo-composer-background/border/focus-border` | Enabled composer resting/focus colors; muted state remains separate |
| `--pilo-shadow-composer`                         | Resting composer shadow                                             |
| `--pilo-shadow-composer-hover/focus`             | Optional interaction shadows; fall back to the resting value        |
| `--pilo-field-hover-border/focus-border`         | Field border interaction colors                                     |
| `--pilo-field-shadow`                            | Input and Select elevation                                          |
| `--pilo-field-touch-height`                      | Field minimum height on coarse pointers                             |
| `--pilo-button-primary-shadow`                   | Filled primary button elevation                                     |
| `--pilo-button-secondary-shadow`                 | Secondary, outline and destructive button elevation                 |

For shadows used by Tailwind-backed controls, use `0 0 #0000` to remove
visible elevation, not `none`: the shadow participates in a combined stack
that also contains keyboard-focus rings. A plain sidebar shadow may use `none`.
Explicit component
utility overrides (for example the composer's borderless textarea and shadowless
send button) still take precedence over shared component defaults.

### Context usage indicator

The context usage indicator stays neutral rather than following the primary
accent. The occupied arc uses the control’s current text color at 70% opacity;
the details progress fill uses `--foreground` at 70% opacity. Percentage and
usage text, empty tracks and the unknown-usage icon also remain neutral.

### Floating surfaces and menus

| Tokens                                                                | Effect                                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `--pilo-floating-radius`, `--pilo-shadow-floating`                    | Default Popover, Select and HoverCard shape/elevation                    |
| `--pilo-context-details-radius`                                       | Context-usage details card; defaults to the `xl` radius                  |
| `--pilo-sheet-radius/padding/item-radius`                             | Run-config bottom sheet, model-list inset and shared inner-control curve |
| `--pilo-menu-radius`                                                  | Menu and searchable font-menu outer curve                                |
| `--pilo-segment-radius/padding/item-radius`                           | Mobile navigation switch, its inset and derived selected curve           |
| `--pilo-tooltip-border/shadow`                                        | Tooltip edge/elevation                                                   |
| `--pilo-menu-background/edge/shadow`                                  | Menu surface and its non-layout-affecting outline                        |
| `--pilo-menu-padding`, `--pilo-menu-item-height/radius`               | Menu density and item geometry                                           |
| `--pilo-menu-item-gap`                                                | Space between adjacent menu items                                        |
| `--pilo-menu-checked-background`                                      | Checked menu item fill                                                   |
| `--pilo-select-padding/gap`, `--pilo-select-item-height/radius`       | Select density and geometry                                              |
| `--pilo-select-checked-background/foreground`                         | Checked Select item colors                                               |
| `--pilo-menu-touch-height`, `--pilo-command-touch-height`             | Coarse-pointer item minimums                                             |
| `--pilo-shadow-2xs/xs/sm/md/lg/xl/2xl`, `--pilo-shadow-panel/popover` | Shared elevation scale                                                   |

Inset surfaces derive their radius from the enclosing radius minus the actual
padding and border, clamped at zero. Menu, sheet and segment item radii follow
this rule in both presets; their item-radius tokens remain independently
overridable. A menu's shadow outline does not consume layout space. Font menus
have a real 1px border, so their Command clipping curve and item curves subtract
that additional pixel. Model lists use menu padding on desktop and sheet padding
on touch, including scope-editing mode. Touch model search fields, scope tabs,
refresh, reasoning and scope-editing action buttons share
`--pilo-sheet-item-radius` with model rows; the scope-tab strip adds its 2px inset
to that inner radius. Theme-option delete buttons subtract their actual inset
from the control radius, including the coarse-pointer variant. Compact desktop
scope tabs subtract their 2px inset from the tab strip radius. Markdown code and
diagram surfaces use runtime radius tokens instead of fixed values.

For example, adjusting the outer shape and inset updates its inner curve without
requiring another selector override:

```css
:root {
	--pilo-menu-radius: 1rem;
	--pilo-menu-padding: 0.375rem;
	--pilo-context-details-radius: 1rem;
	--pilo-sheet-radius: 1.25rem;
	--pilo-sheet-padding: 0.5rem;
	--pilo-segment-radius: 0.75rem;
	--pilo-segment-padding: 0.25rem;
}
```

Here menu items default to 10px, sheet model items to 12px and segment items to
8px at a 16px root size. General floating-surface radius stays independent of
the larger details-card and bottom-sheet roles.

## Troubleshooting

| Symptom                            | What to check                                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Edits have no visible effect       | Enter a name, fix any validation errors, and choose **Save and apply** or **Update and apply**. The editor is not a live preview.                                              |
| A color is rejected                | Use a complete color value, such as `hsl(14 61.7% 47%)` rather than the bare HSL channels used by some CSS source variables. Check whether the token requires an opaque color. |
| Only one mode looks correct        | Set separate light and dark values for affected colors. A light override also applies in dark mode when the dark field is empty.                                               |
| A token does not appear            | Search without `--`. A CSS variable in a preset may not be part of the editor's shared catalog.                                                                                |
| Deleted theme still appears active | Deleting removes only the saved entry. Select **Lody** or **Claude** to remove active custom overrides.                                                                        |
| WebUI does not match the desktop   | Check that WebUI is connected to the intended Host. In **Follow system** mode, devices can resolve to different appearances.                                                   |

## Startup and safety

The startup shell loads the same native token presets before its boot script.
Its geometry, colors and composer read the same public tokens, including cached
custom overrides. There is no duplicated Claude boot palette or geometry branch.
The system-bar `theme-color` follows computed `--background` after theme changes.
The preset stylesheet is also included in WebUI offline precaching.

There is no separate theme preview or rollback control. Save and apply the
custom theme to inspect menus, focus states and mobile layouts. If controls
become hard to read, switch back to a built-in theme in WebUI or the desktop.

## Claude reference

The Claude values reference the third-party `open-claude-ui` reconstruction,
not an official specification. The light palette follows the Claude Code desktop
reference: near-white canvas, a subtle neutral sidebar, `#f0f0ef` user messages
and neutral-gray selections, while retaining the terracotta accent. Pilo keeps
its compact composer, surface-role mapping and contrast adjustments. Its 8/12/16px
radius scale, 12px bubble and 16px composer remain adaptations rather than
pixel-identical copies. They are ordinary configurable token values, not
privileged built-in behavior. Copernicus is not bundled; display headings use
system serif fallbacks when it is unavailable.
