import React, { type ReactNode } from "react";

import { cn } from "@/lib/utils";

export const SETTINGS_CONTAINER_CLASS = "space-y-3";

export const SETTINGS_CONTROL_CLASS = "h-8 px-2.5 py-0 text-sm md:text-sm";

export const SETTINGS_ICON_BUTTON_CLASS =
	"h-8 w-8 rounded-md text-muted-foreground hover:text-foreground [&_svg]:size-4";

export const SETTINGS_TEXT_BUTTON_CLASS =
	"h-8 gap-1.5 px-2 text-xs font-normal [&_svg]:size-3.5";

export const SETTINGS_NESTED_DIALOG_OVERLAY_CLASS =
	"z-[var(--z-dialog)] bg-black/20";

export function SettingsStatus({
	children,
	muted = false,
}: {
	children: ReactNode;
	muted?: boolean;
}) {
	return (
		<span
			className={cn(
				"inline-flex h-6 items-center rounded-md border px-2 text-[11px] font-medium",
				muted
					? "border-border/60 bg-muted/35 text-muted-foreground"
					: "border-border/70 bg-background text-foreground/80",
			)}
		>
			{children}
		</span>
	);
}

type SettingsSectionProps = {
	title?: string;
	description?: string;
	actions?: ReactNode;
	headerRight?: ReactNode;
	children: ReactNode;
	className?: string;
	contentClassName?: string;
};

type SettingsRowProps = {
	label: string;
	helper?: ReactNode;
	children?: ReactNode;
	className?: string;
};

export function SettingsSection({
	title,
	description,
	actions,
	headerRight,
	children,
	className,
	contentClassName,
}: SettingsSectionProps) {
	return (
		<section
			className={cn(
				"overflow-hidden rounded-lg border border-border/70 bg-card/60 text-sm shadow-none",
				className,
			)}
		>
			{title || headerRight ? (
				<header className="flex min-h-10 items-center justify-between gap-2 border-b border-border/70 bg-muted/40 px-3 py-1.5">
					<div className="min-w-0 flex-1 leading-tight">
						{title ? (
							<p className="text-xs font-semibold text-muted-foreground">
								{title}
							</p>
						) : null}
						{description ? (
							<p className="text-[11px] text-muted-foreground/90">
								{description}
							</p>
						) : null}
					</div>
					{headerRight ? (
						<div className="min-w-0 shrink truncate text-right text-[11px] text-muted-foreground">
							{headerRight}
						</div>
					) : null}
					{actions ? (
						<div className="flex shrink-0 items-center gap-1.5">
							{React.Children.map(actions, (child) => {
								if (
									!React.isValidElement<{
										size?: string;
										variant?: string;
										className?: string;
									}>(child)
								)
									return child;
								return React.cloneElement(child, {
									size: child.props.size ?? "icon",
									variant: child.props.variant ?? "default",
									className: cn(
										"h-7 w-7 rounded-md shadow-xs focus-visible:ring-1 focus-visible:ring-ring/60 [&_svg]:size-3.5",
										child.props.className,
									),
								});
							})}
						</div>
					) : null}
				</header>
			) : null}
			<div className={cn("divide-y divide-border/60", contentClassName)}>
				{children}
			</div>
		</section>
	);
}

export function SettingsRow({
	label,
	helper,
	children,
	className,
}: SettingsRowProps) {
	return (
		<div
			className={cn(
				"flex flex-col gap-2 px-3 py-2 sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4",
				className,
			)}
		>
			<div className={cn("min-w-0", helper && "sm:max-w-[520px]")}>
				<p className="font-medium leading-tight text-foreground">{label}</p>
				{helper ? (
					<p className="text-[11px] leading-tight text-muted-foreground">
						{helper}
					</p>
				) : null}
			</div>
			{children ? (
				<div className="flex min-w-0 flex-wrap items-center gap-2 text-sm sm:justify-end sm:pl-4">
					{children}
				</div>
			) : null}
		</div>
	);
}
