# Implementation Plan

## 1. Add the i18n foundation

- Add `i18next` and `react-i18next`.
- Add `src/i18n/locale.ts` with:
  - `AppLocale` and supported locale constants;
  - stored-locale validation;
  - system locale resolution (`zh-*` → `zh-CN`, otherwise `en-US`);
  - the dedicated locale storage key.
- Add bundled `en-US` and `zh-CN` resource modules.
- Add the i18next instance/configuration and TypeScript module augmentation with
  strict translation-key checking.
- Add unit tests for locale resolution and validation; register the test file in
  the explicit `test:unit` script.

Validation checkpoint:

```bash
pnpm format
pnpm check
pnpm build
pnpm test:unit
```

## 2. Bootstrap i18n before React render

- Initialize i18next before `createRoot().render()`.
- Set `document.documentElement.lang` from the resolved locale.
- Ensure startup keeps the existing boot shell until translations are ready.
- Make RootErrorBoundary use current translated copy without React hooks.

Review gate: verify there is no render path that can show the wrong locale
before i18n initialization completes.

## 3. Add the language setting

- Add a language row to the existing Preferences settings surface.
- Expose only:
  - `简体中文` → `zh-CN`
  - `English` → `en-US`
- Persist manual selection and call `changeLanguage()` immediately.
- Keep the option labels as autonyms rather than translating them.

Manual checkpoint: switch both directions without restart and confirm the
settings dialog updates in place.

## 4. Decouple pure logic from localized copy

Refactor high-value shared modules before bulk component migration:

- `src/lib/app-error.ts`
  - preserve stable error code/action/detail;
  - translate user-facing messages/actions at presentation time;
  - avoid storing translated error strings in long-lived runtime state.
- `src/lib/chat-activity-state.ts`
  - return stable status semantics instead of Chinese labels where needed.
- `src/lib/format-duration.ts`
  - retain pure numeric formatting and move unit labels to locale-aware callers.
- `src/lib/keyboard-shortcuts.ts`
  - keep IDs/default shortcuts/stable section IDs;
  - move label/description copy into resources.
- Audit other `src/lib/*` modules for user-facing hard-coded strings.

Update affected Node unit tests to assert stable logic instead of one language
when appropriate.

## 5. Migrate frontend UI copy

Work area-by-area to keep reviews bounded:

1. settings;
2. sidebar/project/session navigation and command palette;
3. chat/composer/activity/recovery surfaces;
4. file/project/preview/terminal/right-sidebar panels;
5. app-shell/title/empty/loading/error surfaces;
6. toasts, tooltips, placeholders, and accessibility copy.

For each area:

- replace hard-coded user-visible strings with semantic keys;
- move interpolation into translation resources/options;
- avoid translating user/Agent/project/file/terminal content;
- verify both locale resources contain the same key shape.

Use repository searches to audit remaining Chinese source text, but classify
comments, test fixtures, and `zh-CN` resources separately rather than requiring
a literal zero-match grep.

## 6. Localize non-React presentation adapters

- Move desktop notification title/body generation to send-time translation.
- Audit other non-React modules that generate user-visible text.
- Ensure no translated constants are captured at module initialization.

Manual checkpoint: send the test notification and verify both locales.

## 7. Make Local connection persistence locale-neutral

- Change newly ensured Local connection rows to canonical `name = "Local"`.
- Add a narrow schema migration for existing `id = "local", name = "本地"`
  rows.
- Change frontend connection display code to derive the built-in Local label
  from stable connection identity/kind and the active locale.
- Keep user-defined WSL/SSH names untouched.
- Audit places that currently concatenate `connection.name` into UI copy.

Rust validation checkpoint:

```bash
cargo fmt --all --check
cargo check
cargo clippy --all-targets --all-features -- -D warnings
```

## 8. Audit locale-sensitive formatting

- Review `toLocaleString()`, date/time, relative-time, and duration output.
- Use the active app locale explicitly where formatting should track Pilo's
  selected language rather than the OS language.
- Preserve intentionally technical/untranslated values.

## 9. Update Trellis guidance

Update the frontend quality/state guidance so that:

- user-facing copy supports `zh-CN` and `en-US`;
- new built-in user-facing strings must go through the i18n resources;
- stable domain/state values must not be localized at persistence/state-machine
  boundaries;
- locale state is documented as low-frequency app-global state managed by the
  i18n layer.

## 10. Full validation and review

Run:

```bash
pnpm format
pnpm check
pnpm build
pnpm test:unit
cargo fmt --all --check
cargo check
cargo clippy --all-targets --all-features -- -D warnings
```

Then perform Windows desktop verification:

- clean/no-locale startup on a Chinese system locale;
- clean/no-locale startup with a mocked/non-Chinese locale if practical;
- Chinese → English live switch;
- English → Chinese live switch;
- restart persistence;
- settings, sidebar, chat, command palette, error/recovery UI;
- desktop test notification;
- Local connection display and existing database migration;
- check for mixed-language built-in copy.

## Rollback Points

- If i18n bootstrap causes startup regressions, revert the root initialization
  change while leaving resource files isolated.
- If a specific feature migration causes behavioral regressions, revert that
  area without changing the i18n foundation.
- The Local connection DB migration is intentionally narrow and does not alter
  connection IDs or user-defined names.
