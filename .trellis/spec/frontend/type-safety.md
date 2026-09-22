# Type Safety

> TypeScript conventions. Strict mode is on and `any` is effectively banned.

---

## Compiler Config

`tsconfig.json`: `strict: true`, `noUnusedLocals`, `noUnusedParameters`,
`noFallthroughCasesInSwitch`, `isolatedModules`, `noEmit`, JSX `react-jsx`.
Path alias: `@/*` → `./src/*`. The project type-checks via `tsc` inside
`pnpm build` (there is no separate `typecheck` script).

## Conventions

- **No `any`.** The codebase has zero `any` / `as any` / `@ts-ignore`. Use
  `unknown` at boundaries and narrow it.
- Exhaustive unions for domain state. `ConversationState` / `ChatMessage` in
  `src/lib/conversation-types.ts` are discriminated unions on `role`:

```ts
export type ChatMessage =
	| { id: string; role: "user"; text: string; ... }
	| { id: string; role: "assistant"; text: string; ... }
	| { id: string; role: "compaction"; text: string; ... };
```

- Types live next to the logic they describe (`conversation-types.ts`,
  `chat-runtime-types.ts`) and are imported with `import type { ... }` when
  used only as types.
- Backend mirrors are declared on the frontend for every `invoke` call; give
  `invoke<Result>` an explicit type argument:

```ts
return invoke<SessionIndexEntry[]>("session_list", { projectId });
```

- Prefer `readonly T[]` for inputs that must not be mutated
  (`initialImages?: readonly ChatImageAttachment[]`).
- `as` casts are rare. The few in the codebase are at third-party library
  boundaries (Radix/xterm refs) — keep them there, not in app logic.
- Use `Reflect.get` / explicit narrowing when reading possibly-missing fields
  off `unknown` objects (see `rawErrorMessage` in `src/lib/app-error.ts`).

## Error Typing

- Unknown failures go through `toAppError(error: unknown): AppError`
  (`src/lib/app-error.ts`). Never assume a thrown value is `Error`.

## Forbidden

- `any`, `as any`, `@ts-ignore`, `@ts-expect-error` without a documented reason.
- Non-null assertion `!` on values that can legitimately be absent.
- `enum` — use string-literal union types.
- Duplicating backend types by hand where a shared protocol type exists
  (`crates/pilo-protocol`); when unavoidable, keep the mirror minimal and next
  to its client function in `src/lib`.
