import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type SettingsSectionProps = {
	title?: string;
	description?: string;
	children: ReactNode;
	className?: string;
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
	children,
	className,
}: SettingsSectionProps) {
	return (
		<section
			className={cn(
				"overflow-hidden rounded-lg border border-border/70 bg-card/60 text-sm shadow-none",
				className,
			)}
		>
			{title ? (
				<header className="flex min-h-10 items-center border-b border-border/70 bg-muted/40 px-3 py-1.5">
					<div className="min-w-0 leading-tight">
						<p className="text-xs font-semibold text-muted-foreground">
							{title}
						</p>
						{description ? (
							<p className="text-[11px] text-muted-foreground/90">
								{description}
							</p>
						) : null}
					</div>
				</header>
			) : null}
			<div className="divide-y divide-border/60">{children}</div>
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
				"grid min-h-[58px] grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-3 py-2",
				className,
			)}
		>
			<div className="min-w-0 sm:max-w-[520px]">
				<p className="font-medium leading-tight text-foreground">{label}</p>
				{helper ? (
					<p className="mt-0.5 text-[11px] leading-tight text-muted-foreground">
						{helper}
					</p>
				) : null}
			</div>
			{children ? (
				<div className="flex min-w-0 items-center justify-end gap-2 pl-4 text-sm">
					{children}
				</div>
			) : null}
		</div>
	);
}
