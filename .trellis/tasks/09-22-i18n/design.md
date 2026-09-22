# Technical Design

## Summary

Use `i18next` with `react-i18next` and bundled TypeScript resources. Keep the
locale bootstrap independent from `PreferencesProvider` so Pilo can resolve and
initialize the correct language before the first React render. Translate at
presentation boundaries; keep protocol, state-machine, and persisted domain
values locale-neutral.

## Library Choice

Add:

- `i18next`
- `react-i18next`

Do not add:

- an HTTP/backend loader;
- `i18next-browser-languagedetector`;
- a translation extraction CLI in the initial implementation.

The app has only two bundled locales and a deliberately simple detection rule,
so explicit detection/persistence is smaller and more deterministic than adding
a detector plugin.

Current official i18next/react-i18next documentation confirms that:

- `useTranslation()` exposes the translation function and language-changing
  i18n instance;
- `changeLanguage()` is the supported runtime switch mechanism;
- i18next initialization should complete before calling `t()`;
- TypeScript module augmentation can provide type-safe translation keys, with
  `strictKeyChecks` available for stricter validation.

See `research/i18n-current-state.md` for references.

## Module Layout

Proposed structure:

```text
src/
  i18n/
    index.ts
    locale.ts
    resources/
      en-US.ts
      zh-CN.ts
  @types/
    i18next.d.ts
```

A single default namespace is sufficient for the current application. Resources
are bundled into the Vite build; there is no async network loading.

Use semantic keys grouped by product area, for example:

```text
settings.language.label
settings.appearance.theme.light
chat.status.starting
chat.status.thinking
errors.authenticationFailed
notifications.agentCompleted.title
shortcuts.commands.newChat.label
```

English is the schema/source resource for typing. The Chinese resource must
match the same key shape.

## Locale Model

```ts
type AppLocale = "zh-CN" | "en-US";
```

A locale helper owns:

- supported-locale validation;
- initial system-language resolution;
- localStorage read/write;
- updating `document.documentElement.lang`.

Use a dedicated bootstrap-safe storage key (for example `pilo.locale`) rather
than embedding locale inside `pilo.preferences.v1`. This mirrors the existing
separate theme storage and avoids coupling i18n startup to the preferences
provider.

Resolution order:

```text
valid stored locale
      ↓
active locale

no valid stored locale
      ↓
navigator.language startsWith("zh")
      ├─ yes → zh-CN
      └─ no  → en-US
```

Only the primary `navigator.language` is required by the agreed product rule;
there is no "System" state retained after resolution.

## Bootstrap and Runtime Switching

Initialize i18next with bundled resources before rendering the React root:

```text
read stored/system locale
        ↓
await initializeI18n(locale)
        ↓
set <html lang>
        ↓
React createRoot(...).render(...)
```

This prevents a flash where the system language renders first and a stored user
preference is applied one frame later.

For runtime switching:

1. validate the requested `AppLocale`;
2. persist it;
3. call `i18n.changeLanguage(locale)`;
4. update `document.documentElement.lang`.

React components using `useTranslation()` re-render from the i18next language
change. The language selector lives in the existing Preferences settings screen
and uses stable option labels `简体中文` and `English`.

No custom global store or additional React context is required.

## Translation Boundaries

### React presentation

Components use `useTranslation()` and translate as close to rendering as
possible. This includes visible text, tooltip text, dialog descriptions,
placeholders, and accessibility labels.

### Static configuration metadata

Static registries must keep stable IDs rather than translated strings.

Example: `SHORTCUT_COMMANDS` should retain command IDs/default shortcuts and a
stable section identifier. Labels/descriptions are resolved from translation
keys by the settings UI. Do not evaluate `i18n.t()` once at module import time.

### Pure state/domain logic

Reducers, state machines, parsers, and reusable pure helpers should return
semantic state/codes or accept locale-neutral formatting inputs. They should not
store translated labels that become stale after a language change.

Examples to refactor:

- `chat-activity-state.ts`: expose a semantic activity status or let the
  rendering layer map status to translation keys.
- `app-error.ts`: preserve normalized `AppErrorCode` / action / detail and
  derive user-facing messages from the active locale at the UI boundary.
- `format-duration.ts`: keep the numeric formatter pure and supply
  locale-specific unit labels at the display boundary.

Transient toasts created before a language switch do not need to mutate in
place, but newly created toasts must use the current locale.

### Non-React user-facing adapters

Adapters that produce presentation output outside React, such as desktop
notifications, may use the initialized shared i18next instance at send time.
They must not cache translated constants at module initialization.

The root class error boundary may also use the initialized i18n instance
directly because React hooks are unavailable in class components.

## Connection Domain Data

The current built-in Local connection leaks presentation text into persisted
domain data.

Change the invariant to:

```text
database/domain:
  id = "local"
  name = "Local"       # canonical, not presentation

UI:
  kind/id is local
    zh-CN → 本地
    en-US → Local
```

Add a storage migration that rewrites only the built-in row
`id = 'local' AND name = '本地'` to `Local`. Do not touch user-defined
connection names.

Any frontend location that displays `connection.name` must use a display-name
helper for the built-in local connection. Rust uses of `connection.name` for
runtime/log labels can use the canonical `Local` value.

## Error Model

Do not use localized strings as classification input. Existing raw/backend error
matching remains based on machine/raw text.

Refactor normalized application errors so their stable fields drive UI copy:

```text
raw error
  ↓
AppErrorCode / area / action / detail
  ↓
translation key
  ↓
localized message at presentation time
```

Where a long-lived state object currently stores `appError.message`, store the
structured error or stable code instead so switching locale updates the mounted
notice.

Raw `detail` remains unchanged and may be shown in diagnostic surfaces.

## Locale-Sensitive Formatting

Audit user-facing uses of:

- `toLocaleString()`;
- date/time formatting;
- duration/unit labels;
- relative-time labels.

When formatting semantics differ by locale, pass the active app locale
explicitly rather than implicitly using the OS locale. Preserve existing compact
UX where both locales intentionally use the same technical abbreviation.

Do not use locale-aware case conversion for protocol/identifier matching unless
the existing behavior specifically requires it.

## Accessibility

On language changes:

- update `document.documentElement.lang`;
- translate `aria-label`, dialog descriptions, screen-reader-only text, and
  tooltip copy;
- keep language option autonyms stable so users can recover from choosing an
  unfamiliar UI language.

Both supported languages are LTR, so no RTL layout work is required.

## Compatibility and Migration

Existing installations have no locale preference:

- `zh-*` systems remain Chinese after upgrade;
- non-Chinese systems start in English after upgrade.

Existing local-connection DB rows may contain `本地`; migrate only that
built-in record to `Local`.

No session/conversation data migration is required because conversation content
is not translated or rewritten.

## Testing Strategy

Add pure unit coverage for:

- supported-locale validation;
- `zh-*` versus non-`zh` initial locale resolution;
- invalid stored-locale fallback;
- any refactored stable status/error mapping helpers;
- locale-independent duration formatting contracts if changed.

Update existing tests that assert Chinese presentation strings so they assert
stable semantic values where the logic layer is being decoupled from copy.

React surfaces remain validated through TypeScript/build plus Windows desktop
manual verification, per project convention.

## Rollback

The feature is additive except for the canonical Local-connection migration.
Rollback is safe because older builds already recognize `Local` in historical
migration logic and the row identity remains `id = "local"`. If needed, the UI
can continue displaying `connection.name` without losing connection identity
or project relations.
