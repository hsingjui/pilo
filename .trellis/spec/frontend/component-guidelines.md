# Component Guidelines

> React component patterns used in this codebase.

---

## Component Style

- Function components only. No class components except the root error boundary
  in `src/main.tsx`.
- Named exports: `export function ChatCopyButton(...)`. `src/App.tsx` uses a
  default export because `main.tsx` imports it that way.
- Inline the props type for small components; declare a named `Props`/options
  type when it is reused or large.

```tsx
export function ChatCopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	...
}
```

## `src/ui` Primitives

Follow the shadcn/ui shape:

- `cva(...)` for variants.
- `React.forwardRef` with a `displayName`.
- `asChild` support via `@radix-ui/react-slot` for polymorphic primitives.
- Classes merged with `cn()` from `@/lib/utils`.

```tsx
const buttonVariants = cva("inline-flex ...", {
	variants: {
		variant: { default: "...", ghost: "...", outline: "..." },
		size: { default: "h-9 px-4 py-2", sm: "h-8 ...", icon: "h-9 w-9" },
	},
	defaultVariants: { variant: "default", size: "default" },
});
```

Feature code composes primitives with `variant`/`size` props instead of
re-styling them.

## Composition & Layout

- Feature components own their layout and state; primitives stay dumb.
- Long/multi-part UI is split into focused files co-located in the feature folder
  (e.g. `chat-composer.tsx`, `chat-composer-frame.tsx`, `chat-composer-actions.tsx`).
- Heavy features are lazy-loaded with `React.lazy` + `Suspense` in `src/App.tsx`
  (`ChatPage`, `ProjectViewer`, `RightSidebar`, `TerminalDock`).

## Styling

- Tailwind utility classes only; design tokens via CSS variables
  (`bg-background`, `text-muted-foreground`, `ring-ring`, …). No hardcoded colors.
- Use `size-4` (not `h-4 w-4`) for square icons.
- Icons come from `lucide-react`; pass them as children to primitives.

## Accessibility

- Interactive icon-only controls need `aria-label`.
- Prefer Radix primitives (Dialog, Tooltip, Select, …) for focus and keyboard
  behavior rather than hand-rolled widgets.
- `oxlint` runs the `jsx-a11y` plugin — accessibility warnings are lint failures.

## Header Actions & Menus

- `SessionHeader` (`src/components/chat/chat-session-header.tsx`) owns the right-side
action group (terminal / temporary chat / panel / session menu). New per-session
actions go there and appear only for persisted sessions (`session && !session.temporary`).
- Session actions that need chat data flow as optional callbacks from `App.tsx`
  through `ChatPage` props (`onRenameSession`, `onOpenInNewWindow`, …). When an
  action targets the focused viewport (e.g. scrolling to a search hit), pass a
  stable callback such as `onNavigate(messageIndex)` instead of a ref — reading
  `ref.current` inside an effect would otherwise fail the `exhaustive-deps` lint.
- Header components expose optional callbacks; they never wire runtime/Pi calls
  themselves. The parent supplies the handlers.

## Multi-Window (Tauri)

- Create additional windows only through `src/lib/window.ts`; do not call the
  Tauri window API directly from components.
- Any new window label pattern must be declared in the `windows` list of
  `src-tauri/capabilities/default.json` (e.g. `"session-*"`), and creating a
  webview window requires the `core:webview:allow-create-webview-window`
  permission. A capability that only lists `"main"` leaves the new window
  without permissions.
- New windows boot stateless: pass state through URL query params and re-resolve
  it once the project index is ready (see `readSessionWindowTarget` and the boot
  effect in `src/App.tsx`, which delegates to `workspace.openSearchSession`).
- In-conversation find reuses `jumpToMessageIndex` from
  `use-chat-scroll-controller.ts` for programmatic jumps; message plain text
  comes from `messageSearchText` in `src/lib/conversation-outline.ts` so the
  outline and the finder share one extraction path.

## Copy

- User-facing strings are Simplified Chinese (`"复制"`, `"重试"`, …), matching the
  existing UI. Keep code identifiers and comments in English.
