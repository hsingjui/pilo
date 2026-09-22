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

## Copy

- User-facing strings are Simplified Chinese (`"复制"`, `"重试"`, …), matching the
  existing UI. Keep code identifiers and comments in English.
