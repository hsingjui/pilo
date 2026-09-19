import {
	CircleAlert,
	CircleCheck,
	Info,
	LoaderCircle,
	TriangleAlert,
} from "lucide-react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

import { useResolvedTheme } from "@/lib/theme-provider";
import { cn } from "@/lib/utils";

const Toaster = ({
	closeButton = true,
	position = "top-center",
	style,
	toastOptions,
	...props
}: ToasterProps) => {
	// Sonner must be told the RESOLVED theme; its own `system` handling reads
	// prefers-color-scheme, which disagrees whenever the user picked explicitly.
	const resolvedTheme = useResolvedTheme();

	return (
		<Sonner
			theme={resolvedTheme}
			className="toaster group"
			closeButton={closeButton}
			position={position}
			offset="20px"
			icons={{
				success: (
					<CircleCheck className="size-4 shrink-0 text-status-success" />
				),
				info: <Info className="size-4 shrink-0 text-muted-foreground" />,
				warning: (
					<TriangleAlert className="size-4 shrink-0 text-status-warning" />
				),
				error: <CircleAlert className="size-4 shrink-0 text-status-danger" />,
				loading: (
					<LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" />
				),
			}}
			toastOptions={{
				...toastOptions,
				// Sonner injects its own UNLAYERED CSS at runtime, which beats every
				// Tailwind utility inside `@layer` regardless of specificity — only
				// `!important` utilities can override it. Spread caller classNames
				// first so the merged defaults below win.
				classNames: {
					...toastOptions?.classNames,
					toast: cn(
						"group/toast font-sans overflow-hidden",
						"rounded-xl border border-border bg-popover text-popover-foreground shadow-popover!",
						"py-3! px-3.5! pr-8! flex items-start! gap-2.5! text-[13px] leading-snug",
						toastOptions?.classNames?.toast,
					),
					content: cn(
						"min-w-0 flex-1 flex flex-col gap-0.5",
						toastOptions?.classNames?.content,
					),
					title: cn(
						"font-medium text-popover-foreground leading-5 text-[13px]",
						toastOptions?.classNames?.title,
					),
					description: cn(
						"text-xs text-muted-foreground! leading-4! mt-0.5 break-words",
						toastOptions?.classNames?.description,
					),
					icon: cn("mt-0.5 shrink-0", toastOptions?.classNames?.icon),
					actionButton: cn(
						"h-7! px-2.5! rounded-md! text-xs font-medium shrink-0 select-none",
						"bg-primary! text-primary-foreground! hover:bg-[hsl(var(--button-hover))]!",
						"active:scale-[0.96]",
						toastOptions?.classNames?.actionButton,
					),
					cancelButton: cn(
						"h-7! px-2.5! rounded-md! text-xs font-medium shrink-0 select-none",
						"bg-secondary! text-secondary-foreground! hover:bg-hover! hover:text-foreground!",
						"active:scale-[0.96]",
						toastOptions?.classNames?.cancelButton,
					),
					closeButton: cn(
						"left-auto! right-2.5! top-2.5! size-5! rounded-md! border-transparent! bg-transparent! text-muted-foreground!",
						"hover:bg-hover! hover:text-popover-foreground! active:scale-[0.92]! flex items-center justify-center select-none",
						"opacity-0 group-hover/toast:opacity-100 focus-visible:opacity-100",
						toastOptions?.classNames?.closeButton,
					),
				},
			}}
			style={
				{
					zIndex: "var(--z-toast, 100)",
					"--normal-bg": "hsl(var(--popover))",
					"--normal-text": "hsl(var(--popover-foreground))",
					"--normal-border": "hsl(var(--border))",
					"--border-radius": "12px",
					"--toast-close-button-transform": "none",
					...style,
				} as React.CSSProperties
			}
			{...props}
		/>
	);
};

export { Toaster };
