import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
	"pilo-button inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-[color,background-color,border-color,scale] active:scale-[0.96] focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-']):not([class*='h-']):not([class*='w-'])]:size-4 [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				default:
					"bg-primary text-primary-foreground shadow-(--pilo-button-primary-shadow) hover:bg-[hsl(var(--button-hover))]",
				destructive:
					"bg-destructive text-destructive-foreground shadow-(--pilo-button-secondary-shadow) hover:bg-destructive/90",
				outline:
					"border border-input-border bg-background shadow-(--pilo-button-secondary-shadow) hover:bg-hover hover:text-hover-foreground",
				secondary:
					"bg-[hsl(var(--button-secondary))] text-[hsl(var(--button-secondary-foreground))] shadow-(--pilo-button-secondary-shadow) hover:bg-[hsl(var(--button-secondary-hover))]",
				ghost: "hover:bg-hover hover:text-hover-foreground",
				link: "text-primary underline-offset-4 hover:underline",
			},
			size: {
				default: "pilo-button-default",
				sm: "pilo-button-sm text-xs",
				lg: "pilo-button-lg",
				icon: "pilo-button-icon",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

export interface ButtonProps
	extends
		React.ButtonHTMLAttributes<HTMLButtonElement>,
		VariantProps<typeof buttonVariants> {
	asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
	({ className, variant, size, asChild = false, ...props }, ref) => {
		const Comp = asChild ? Slot : "button";
		return (
			<Comp
				data-button-variant={variant ?? "default"}
				className={cn(buttonVariants({ variant, size, className }))}
				ref={ref}
				{...props}
			/>
		);
	},
);
Button.displayName = "Button";

export { Button, buttonVariants };
