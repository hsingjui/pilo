import type { CSSProperties } from "react";

// Menu edge color: a fixed small step from the surface toward the foreground,
// shared by the surface ring and inner separators so they read as one line.
const menuEdgeColor =
	"color-mix(in oklab, hsl(var(--background)) 90%, hsl(var(--foreground)) 10%)";

export const menuSurfaceClassName =
	"min-w-[220px] rounded-xl bg-background p-1 text-foreground";

export const menuSurfaceStyle: CSSProperties = {
	backgroundColor: "hsl(var(--background))",
	// The edge is the ring in this shadow stack, not a layout-affecting border.
	boxShadow: `0 0 0 1px ${menuEdgeColor}, 0 4px 12px 0 rgb(0 0 0 / 0.08), 0 1px 3px 0 rgb(0 0 0 / 0.06)`,
};

/** Fixed box for an item's leading glyph; the wrapper sizes the icon. */
export const menuItemIconClassName =
	"flex size-3.5 shrink-0 items-center justify-center text-[color:var(--menu-icon-color,hsl(var(--muted-foreground)))] [&>svg]:size-full";

const menuItemBaseClassName =
	"relative flex w-full min-h-8 cursor-default select-none items-center overflow-hidden gap-3 rounded-lg px-3 py-1.5 text-sm leading-5 outline-hidden data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-3.5";

// An item that owns an open surface stays lit while that surface is open.
const menuItemOpenStateClassName =
	"data-[state=open]:bg-hover data-[state=open]:text-hover-foreground aria-expanded:bg-hover aria-expanded:text-hover-foreground";

export const menuItemClassName = `${menuItemBaseClassName} ${menuItemOpenStateClassName} focus:bg-hover focus:text-hover-foreground`;

/** Item whose leading box is a selection indicator rather than a caller icon. */
export const menuSelectionItemClassName = `${menuItemBaseClassName} ${menuItemOpenStateClassName} ps-8 focus:bg-hover focus:text-hover-foreground`;

export const menuItemDestructiveClassName =
	"data-[variant=destructive]:[--menu-icon-color:hsl(var(--destructive))] data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive";

/** Trailing metadata: a shortcut, a count, a hint. */
export const menuItemExtraClassName =
	"ms-auto ps-4 font-mono text-xs text-muted-foreground/80";

export const menuGroupLabelClassName =
	"select-none px-3 pb-1 pt-2 text-[10px] font-semibold uppercase leading-[14px] tracking-[0.6px] text-muted-foreground/80";

export const menuSeparatorClassName = "my-1 h-px";

export const menuSeparatorStyle: CSSProperties = {
	backgroundColor: menuEdgeColor,
};
