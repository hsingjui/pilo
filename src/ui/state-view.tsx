import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CircleAlert, Inbox, LoaderCircle } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "./button";

type StateViewVariant = "default" | "compact" | "hero";

type StateViewProps = {
	icon: ReactNode;
	title: string;
	description?: string;
	action?: ReactNode;
	variant?: StateViewVariant;
	className?: string;
	role?: "alert";
};

function StateView({
	icon,
	title,
	description,
	action,
	variant = "default",
	className,
	role,
}: StateViewProps) {
	const hero = variant === "hero";
	return (
		<div
			role={role}
			className={cn(
				"flex w-full flex-col items-center justify-center text-center",
				variant === "compact"
					? "min-h-32 gap-2.5 p-4"
					: hero
						? "min-h-64 gap-4 p-6"
						: "min-h-48 gap-3 p-6",
				className,
			)}
		>
			<div
				className={cn(
					"flex items-center justify-center",
					hero
						? "size-20 text-foreground"
						: "size-9 rounded-full bg-muted text-muted-foreground",
				)}
			>
				{icon}
			</div>
			<div className="grid max-w-sm gap-1">
				<p
					className={cn(
						"text-foreground",
						hero
							? "text-3xl font-semibold tracking-tight"
							: "text-sm font-medium",
					)}
				>
					{title}
				</p>
				{description ? (
					<p className="text-xs leading-5 text-muted-foreground">
						{description}
					</p>
				) : null}
			</div>
			{action}
		</div>
	);
}

export function EmptyState({
	title,
	description,
	icon,
	action,
	variant,
	className,
}: Omit<StateViewProps, "icon" | "role"> & { icon?: ReactNode }) {
	return (
		<StateView
			icon={icon ?? <Inbox className="size-4" />}
			title={title}
			description={description}
			action={action}
			variant={variant}
			className={className}
		/>
	);
}

export function LoadingState({
	title,
	description,
	variant,
	className,
}: Partial<
	Pick<StateViewProps, "title" | "description" | "variant" | "className">
>) {
	const { t } = useTranslation();
	return (
		<StateView
			icon={<LoaderCircle className="size-4 animate-spin" />}
			title={title ?? t("common.loading")}
			description={description}
			variant={variant}
			className={className}
		/>
	);
}

export function ErrorState({
	title,
	description,
	onRetry,
	retryLabel,
	variant,
	className,
}: Partial<
	Pick<StateViewProps, "title" | "description" | "variant" | "className">
> & {
	onRetry?: () => void;
	retryLabel?: string;
}) {
	const { t } = useTranslation();
	return (
		<StateView
			role="alert"
			icon={<CircleAlert className="size-4" />}
			title={title ?? t("common.loadFailed")}
			description={description}
			variant={variant}
			className={className}
			action={
				onRetry ? (
					<Button type="button" variant="outline" size="sm" onClick={onRetry}>
						{retryLabel ?? t("common.retry")}
					</Button>
				) : undefined
			}
		/>
	);
}
