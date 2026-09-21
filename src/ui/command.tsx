import * as React from "react";
import { type DialogProps } from "@radix-ui/react-dialog";
import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { Dialog, DialogContentWithoutClose } from "./dialog";
import { ScrollArea } from "./scroll-area";

const Command = React.forwardRef<
	React.ElementRef<typeof CommandPrimitive>,
	React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
	<CommandPrimitive
		ref={ref}
		className={cn(
			"flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground",
			className,
		)}
		{...props}
	/>
));
Command.displayName = CommandPrimitive.displayName;

const CommandDialog = ({
	children,
	shouldFilter,
	...props
}: DialogProps & { shouldFilter?: boolean }) => (
	<Dialog {...props}>
		<DialogContentWithoutClose
			noAnimation
			className="top-[12%] flex h-[min(560px,72vh)] w-[640px] max-w-[calc(100vw-3rem)] translate-y-0 flex-col gap-0 overflow-hidden border-0 bg-transparent p-0 shadow-none sm:p-0"
		>
			<Command
				shouldFilter={shouldFilter}
				className="rounded-xl border border-border shadow-popover"
			>
				{children}
			</Command>
		</DialogContentWithoutClose>
	</Dialog>
);

const CommandInput = React.forwardRef<
	React.ElementRef<typeof CommandPrimitive.Input>,
	React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input> & {
		wrapperClassName?: string;
	}
>(({ className, wrapperClassName, ...props }, ref) => (
	<div
		className={cn(
			"flex h-14 items-center border-b border-border px-4",
			wrapperClassName,
		)}
		cmdk-input-wrapper=""
	>
		<Search className="me-3 h-4 w-4 shrink-0 opacity-50" />
		<CommandPrimitive.Input
			ref={ref}
			className={cn(
				"h-full w-full bg-transparent text-base outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
				className,
			)}
			{...props}
		/>
	</div>
));

CommandInput.displayName = CommandPrimitive.Input.displayName;

type CommandListProps = React.ComponentPropsWithoutRef<
	typeof CommandPrimitive.List
> & {
	containerClassName?: string;
	viewportClassName?: string;
};

const CommandList = React.forwardRef<
	React.ElementRef<typeof CommandPrimitive.List>,
	CommandListProps
>(({ className, containerClassName, viewportClassName, ...props }, ref) => (
	<ScrollArea
		className={cn("max-h-[300px]", containerClassName)}
		viewportClassName={cn(
			"scroll-pro scrollbar-pro [scrollbar-gutter:auto] max-h-[300px] overflow-y-auto overflow-x-hidden touch-pan-y",
			viewportClassName,
		)}
	>
		<CommandPrimitive.List
			ref={ref}
			className={cn("min-w-full", className)}
			{...props}
		/>
	</ScrollArea>
));

CommandList.displayName = CommandPrimitive.List.displayName;

const CommandEmpty = React.forwardRef<
	React.ElementRef<typeof CommandPrimitive.Empty>,
	React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>((props, ref) => (
	<CommandPrimitive.Empty
		ref={ref}
		className="py-6 text-center text-sm"
		{...props}
	/>
));

CommandEmpty.displayName = CommandPrimitive.Empty.displayName;

const CommandGroup = React.forwardRef<
	React.ElementRef<typeof CommandPrimitive.Group>,
	React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
	<CommandPrimitive.Group
		ref={ref}
		className={cn(
			"overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground",
			className,
		)}
		{...props}
	/>
));

CommandGroup.displayName = CommandPrimitive.Group.displayName;

const CommandSeparator = React.forwardRef<
	React.ElementRef<typeof CommandPrimitive.Separator>,
	React.ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(({ className, ...props }, ref) => (
	<CommandPrimitive.Separator
		ref={ref}
		className={cn("-mx-1 h-px bg-border", className)}
		{...props}
	/>
));
CommandSeparator.displayName = CommandPrimitive.Separator.displayName;

const CommandItem = React.forwardRef<
	React.ElementRef<typeof CommandPrimitive.Item>,
	React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
	<CommandPrimitive.Item
		ref={ref}
		className={cn(
			"relative flex cursor-default select-none items-center gap-2.5 rounded-md px-2.5 py-2 text-sm outline-hidden data-[selected=true]:bg-hover data-[selected=true]:text-hover-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
			className,
		)}
		{...props}
	/>
));

CommandItem.displayName = CommandPrimitive.Item.displayName;

const CommandShortcut = ({
	className,
	...props
}: React.HTMLAttributes<HTMLSpanElement>) => (
	<span
		className={cn(
			"ms-auto text-xs tracking-widest text-muted-foreground",
			className,
		)}
		{...props}
	/>
);
CommandShortcut.displayName = "CommandShortcut";

export {
	Command,
	CommandDialog,
	CommandInput,
	CommandList,
	CommandEmpty,
	CommandGroup,
	CommandItem,
	CommandShortcut,
	CommandSeparator,
};
