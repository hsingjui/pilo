# i18n Current-State and Library Research

Date: 2026-09-22

## Repository Findings

- There is currently no i18n dependency or locale state in `package.json`.
- A repository scan found roughly 909 TS/TSX source lines containing Chinese
  characters across more than 70 files. This includes both comments and
  user-visible copy; the user-visible subset spans most major UI surfaces.
- High-density user-facing areas include:
  - `src/components/settings/settings-dialog.tsx`
  - `src/components/sidebar/rows.tsx`
  - `src/components/settings/connection-sections.tsx`
  - `src/components/sidebar/app-sidebar.tsx`
  - `src/components/chat/*`
  - `src/lib/keyboard-shortcuts.ts`
  - `src/lib/app-error.ts`
- `src/lib/preferences-provider.tsx` and `src/lib/theme-provider.tsx` show the
  existing convention for low-frequency persisted UI state.
- `src/lib/theme-provider.tsx` already uses a dedicated localStorage key for a
  bootstrap-sensitive global UI preference, which supports using a dedicated
  locale key instead of coupling locale bootstrap to `pilo.preferences.v1`.
- `src-tauri/src/runtime/storage/connections.rs` persists the built-in Local
  connection as `name: "本地"`, while other runtime paths already sometimes
  construct it as `"Local"`. This is presentation leakage into domain data.
- `.trellis/spec/frontend/quality-guidelines.md` currently says
  "User-facing copy is Simplified Chinese" and must be revised.

## Official i18next / react-i18next Findings

Official documentation reviewed on 2026-09-22:

- https://react.i18next.com/latest/usetranslation-hook
  - `useTranslation()` exposes `t` and the i18n instance.
  - Runtime language changes use `i18n.changeLanguage(...)`.
  - Hooks update through react-i18next's language binding.
- https://react.i18next.com/latest/i18nextprovider
  - `I18nextProvider` is mainly needed for multiple instances or SSR.
  - Pilo can use the default instance initialized with the React integration;
    an extra app-specific LocaleProvider is not required.
- https://www.i18next.com/overview/api
  - initialization should complete before using `t()`;
  - `changeLanguage()` returns a Promise and is the supported way to switch
    the active language.
- https://www.i18next.com/overview/typescript
  - module augmentation can type translation resources and keys;
  - `strictKeyChecks` is available;
  - TypeScript resource typing is supported by current i18next versions.

## Decision

Use `i18next + react-i18next` with in-bundle resources and explicit Pilo-owned
locale detection/persistence.

Do not add a browser language detector or remote resource backend because Pilo
has only two locales and a product-specific rule:

```text
stored zh-CN/en-US → use it
otherwise:
  navigator.language starts with zh → zh-CN
  everything else                  → en-US
```

This keeps startup deterministic, supports pre-render initialization, and avoids
unnecessary dependencies.
