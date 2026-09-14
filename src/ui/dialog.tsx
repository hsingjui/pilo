import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { isImeComposingNativeKeyboardEvent } from "@/lib/ime";
import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;

const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = DialogPrimitive.Close;

const dialogOverlayAnimationClasses =
	"data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0";

const DialogOverlay = React.forwardRef<
	React.ElementRef<typeof DialogPrimitive.Overlay>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay> & {
		noAnimation?: boolean;
	}
>(({ className, noAnimation, ...props }, ref) => (
	<DialogPrimitive.Overlay
		ref={ref}
		className={cn(
			"fixed inset-0 z-[var(--z-dialog-overlay)] bg-black/80",
			!noAnimation && dialogOverlayAnimationClasses,
			className,
		)}
		{...props}
	/>
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const dialogBaseClasses =
	"fixed left-[50%] top-[calc(50%+(var(--safe-area-top,0px)-var(--safe-area-bottom,0px))/2)] z-[var(--z-dialog)] grid w-[calc(100vw-4rem)] max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border border-border bg-background p-4 shadow-lg rounded-lg max-h-[calc(100vh-2rem-var(--safe-area-top,0px)-var(--safe-area-bottom,0px))] sm:p-6";

const dialogAnimationClasses =
	"duration-100 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0";

const DialogContent = React.forwardRef<
	React.ElementRef<typeof DialogPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
		overlayClassName?: string;
		noAnimation?: boolean;
	}
>(
	(
		{
			className,
			overlayClassName,
			noAnimation,
			children,
			onEscapeKeyDown,
			...props
		},
		ref,
	) => (
		<DialogPortal>
			<DialogOverlay className={overlayClassName} noAnimation={noAnimation} />
			<DialogPrimitive.Content
				ref={ref}
				className={cn(
					dialogBaseClasses,
					!noAnimation && dialogAnimationClasses,
					className,
				)}
				onEscapeKeyDown={(event) => {
					// Don't dismiss the dialog when Esc only cancels an IME composition.
					if (isImeComposingNativeKeyboardEvent(event)) {
						event.preventDefault();
						return;
					}
					onEscapeKeyDown?.(event);
				}}
				{...props}
			>
				{children}
				<DialogPrimitive.Close className="absolute right-4 top-4 rounded-xs opacity-70 ring-offset-background transition-opacity after:absolute after:-inset-1 after:content-[''] hover:opacity-100 focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-hover data-[state=open]:text-muted-foreground">
					<X className="h-4 w-4" />
					<span className="sr-only">Close</span>
				</DialogPrimitive.Close>
			</DialogPrimitive.Content>
		</DialogPortal>
	),
);
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogContentWithoutClose = React.forwardRef<
	React.ElementRef<typeof DialogPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
		overlayClassName?: string;
		noAnimation?: boolean;
	}
>(
	(
		{
			className,
			overlayClassName,
			noAnimation,
			children,
			onEscapeKeyDown,
			...props
		},
		ref,
	) => (
		<DialogPortal>
			<DialogOverlay className={overlayClassName} noAnimation={noAnimation} />
			<DialogPrimitive.Content
				ref={ref}
				className={cn(
					dialogBaseClasses,
					!noAnimation && dialogAnimationClasses,
					className,
				)}
				onEscapeKeyDown={(event) => {
					if (isImeComposingNativeKeyboardEvent(event)) {
						event.preventDefault();
						return;
					}
					onEscapeKeyDown?.(event);
				}}
				{...props}
			>
				{children}
			</DialogPrimitive.Content>
		</DialogPortal>
	),
);
DialogContentWithoutClose.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({
	className,
	...props
}: React.HTMLAttributes<HTMLDivElement>) => (
	<div
		className={cn("flex flex-col gap-1.5 text-center sm:text-left", className)}
		{...props}
	/>
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({
	className,
	...props
}: React.HTMLAttributes<HTMLDivElement>) => (
	<div
		className={cn(
			"flex flex-col-reverse sm:flex-row sm:justify-end sm:gap-2",
			className,
		)}
		{...props}
	/>
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
	React.ElementRef<typeof DialogPrimitive.Title>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
	<DialogPrimitive.Title
		ref={ref}
		className={cn(
			"text-lg font-semibold leading-none tracking-tight",
			className,
		)}
		{...props}
	/>
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
	React.ElementRef<typeof DialogPrimitive.Description>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
	<DialogPrimitive.Description
		ref={ref}
		className={cn("text-sm text-muted-foreground", className)}
		{...props}
	/>
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
	Dialog,
	DialogPortal,
	DialogOverlay,
	DialogTrigger,
	DialogClose,
	DialogContent,
	DialogContentWithoutClose,
	DialogHeader,
	DialogFooter,
	DialogTitle,
	DialogDescription,
};
