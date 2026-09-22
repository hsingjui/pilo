# Add Simplified Chinese and English i18n

## Goal

Add application-level internationalization for Pilo with exactly two supported UI
languages: Simplified Chinese (`zh-CN`) and English (`en-US`). Preserve the
current Chinese experience while making the full built-in desktop UI usable in
English.

## Confirmed Facts

- The frontend currently has no i18n library or locale state.
- User-facing Simplified Chinese is spread across React components and pure
  modules, including settings, sidebar, chat status, errors, notifications,
  keyboard shortcut metadata, and empty/loading states.
- Locale-sensitive strings currently exist in pure logic such as
  `src/lib/app-error.ts`, `src/lib/chat-activity-state.ts`,
  `src/lib/format-duration.ts`, and `src/lib/keyboard-shortcuts.ts`.
- The local connection display name is currently persisted as localized data
  (`"本地"`) in the Rust storage layer. This must become locale-neutral data
  and be localized only for display.
- The frontend quality spec currently states that user-facing copy is
  Simplified Chinese only; that rule must be updated as part of this task.

## Requirements

### R1. Supported locales

- Support exactly `zh-CN` and `en-US`.
- Do not expose a "System" option in the language selector.
- The language selector must show the language names as stable autonyms:
  `简体中文` and `English`.

### R2. Initial locale selection

When no valid stored language preference exists:

- if the system/WebView primary language starts with `zh` (case-insensitive),
  choose `zh-CN`;
- otherwise choose `en-US`.

This means Traditional Chinese system locales also use the available Simplified
Chinese translation, while every non-Chinese locale falls back to English.

### R3. Persistence and switching

- A manual language selection must take effect immediately without restarting
  Pilo.
- The explicit selection must persist across restarts.
- Once a user has selected a language, later system-language changes must not
  override that stored selection.
- Invalid/unknown stored locale values must be treated as missing and resolved
  through the initial-locale rule.

### R4. Translation coverage

Localize built-in user-facing copy across the application, including:

- settings and dialogs;
- sidebar, project/session navigation, command palette, and title bar;
- chat/composer states, notices, tool/activity labels, empty/loading/error
  states, and contextual controls;
- toasts and application error messages;
- desktop notification title/body text;
- keyboard shortcut labels/descriptions;
- accessibility text such as `aria-label`, screen-reader-only descriptions,
  and tooltip text;
- built-in connection labels such as Local;
- locale-sensitive number/time/duration text where applicable.

### R5. Translation boundary

The following data must remain untranslated and be displayed as supplied:

- user prompts and Agent responses;
- project names, file paths, Git branches, terminal output, and code/Markdown;
- user-defined SSH/connection names;
- raw Pi/backend error details and diagnostic/log messages;
- protocol IDs, enum values, command IDs, and persisted domain data.

Pure state/domain logic must not cache localized presentation strings when doing
so would prevent an already-mounted surface from updating after a language
switch.

### R6. Locale-neutral persisted data

- The built-in Local connection must use a stable locale-neutral persisted name
  (canonical value: `Local`).
- Existing databases containing the built-in local connection name `本地` must
  be migrated to the canonical value.
- UI code must derive the localized display label for the built-in local
  connection from its stable identity/kind rather than from the persisted
  `name` field.
- User-defined connection names must never be translated or rewritten.

### R7. Startup behavior

- Translation resources must be available before the React application renders
  user-facing UI, so a persisted language different from the system language
  does not cause a visible wrong-language flash.
- `document.documentElement.lang` must track the active locale.

### R8. Maintainability

- Use semantic translation keys rather than Chinese source strings as keys.
- Translation keys must be TypeScript-checked against the bundled resource
  schema.
- Locale resources must ship inside the application; no remote translation
  service or runtime HTTP language loading is required.
- Update Trellis frontend guidance so future user-facing copy is added through
  the i18n layer instead of being hard-coded in one language.

## Acceptance Criteria

- [ ] With no stored locale and a `zh-*` system language, Pilo starts in
      Simplified Chinese.
- [ ] With no stored locale and any non-`zh` system language, Pilo starts in
      English.
- [ ] Selecting `简体中文` or `English` updates mounted UI immediately and
      survives an application restart.
- [ ] No "System" language option is exposed.
- [ ] The major built-in UI surfaces listed in R4 have complete Chinese and
      English translations with no mixed-language hard-coded UI copy.
- [ ] Existing Local connection records are migrated to the canonical
      locale-neutral value while the UI still renders `本地` in Chinese and
      `Local` in English.
- [ ] User-provided names/content and raw backend diagnostic details are not
      translated.
- [ ] Locale-sensitive helpers and state models do not retain stale translated
      strings after a runtime language switch.
- [ ] `<html lang>` reflects the active locale.
- [ ] Relevant unit tests cover locale resolution/persistence-facing pure logic
      and any refactored translation-independent format/state helpers.
- [ ] `pnpm format`, `pnpm check`, `pnpm build`, and `pnpm test:unit`
      pass.
- [ ] Rust changes pass `cargo fmt --all --check`, `cargo check`, and
      `cargo clippy --all-targets --all-features -- -D warnings`.
- [ ] Manual Windows desktop verification confirms startup language, switching,
      persistence, settings UI, chat states, toasts, and desktop notifications.

## Out of Scope

- Languages other than `zh-CN` and `en-US`.
- A persistent "follow system" mode.
- Translating Agent-generated conversation content.
- Translating terminal output, file contents, code, Git data, or raw diagnostic
  details.
- Remote language packs, translation management SaaS, or runtime language
  downloads.
- Refactoring unrelated UI or changing product terminology beyond what is
  required for equivalent Chinese/English copy.
