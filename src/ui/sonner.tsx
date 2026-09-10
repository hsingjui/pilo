import { Toaster as Sonner, type ToasterProps } from "sonner";

import { useResolvedTheme } from "@/lib/theme-provider";

const TOAST_BUTTON_CLASS_NAME =
	"mt-2.5! ml-0! -mr-5! h-7! basis-full! justify-center! rounded-md!";

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
			offset="24px"
			toastOptions={{
				...toastOptions,
				classNames: {
					// Leave room on the right for the inline close button.
					toast: "pr-9! items-start! flex-wrap!",
					content: "min-w-0! flex-1! basis-0!",
					icon: "mt-0.5!",
					description: "text-muted-foreground!",
					actionButton: TOAST_BUTTON_CLASS_NAME,
					cancelButton: TOAST_BUTTON_CLASS_NAME,
					closeButton:
						"left-auto! right-2! top-4! size-5! rounded-md! border-transparent! bg-transparent! text-muted-foreground! transition-colors! hover:bg-muted! hover:text-foreground!",
					...toastOptions?.classNames,
				},
			}}
			style={
				{
					zIndex: "var(--z-toast, 100)",
					"--normal-bg":
						"color-mix(in oklab, hsl(var(--popover)) 92%, hsl(var(--foreground)) 8%)",
					"--normal-text": "hsl(var(--popover-foreground))",
					"--normal-border": "hsl(var(--border))",
					"--toast-close-button-transform": "none",
					...style,
				} as React.CSSProperties
			}
			{...props}
		/>
	);
};

export { Toaster };
