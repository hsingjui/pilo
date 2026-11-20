import { type JSX, signal, Text, token, View } from "nsh";

import { Button } from "./button";
import { classNames } from "./class-names";
import { Icon } from "./icon";

type StateText = string | (() => string);

export interface StateViewProps {
	icon: JSX.Element;
	title: StateText;
	description?: StateText;
	/** Under the description, e.g. a selectable error message. */
	detail?: JSX.Element;
	action?: JSX.Element;
	variant?: "default" | "compact" | "hero";
	class?: string;
	testID?: string;
	role?: "alert";
}

/**
 * An empty, loading or failed page part, as React's `src/ui/state-view.tsx`:
 * the icon in a muted circle (bare and large for `hero`), a title, its
 * description and an action. Icons draw in the foreground they are given;
 * pass `muted-foreground` (`hero`: `foreground`) as React's circle does.
 */
export function StateView(props: StateViewProps) {
	const hero = props.variant === "hero";
	return (
		<View
			testID={props.testID}
			role={props.role}
			class={classNames(
				"w-full items-center justify-center",
				props.variant === "compact"
					? "min-h-32 gap-2.5 p-4"
					: hero
						? "min-h-64 gap-4 p-6"
						: "min-h-48 gap-3 p-6",
				props.class,
			)}
		>
			<View
				class={
					hero
						? "size-20 items-center justify-center"
						: "size-9 items-center justify-center rounded-full bg-muted"
				}
			>
				{props.icon}
			</View>
			<View class="max-w-sm items-center gap-1">
				<Text
					class={classNames(
						"text-center font-sans text-foreground",
						hero
							? "text-3xl font-semibold tracking-tight"
							: "text-sm font-medium",
					)}
				>
					{props.title}
				</Text>
				{props.description ? (
					<Text class="text-center font-sans text-xs leading-5 text-muted-foreground">
						{props.description}
					</Text>
				) : null}
				{props.detail}
			</View>
			{props.action}
		</View>
	);
}

/** Nothing to show (React's `EmptyState`); an inbox without an icon. */
export function EmptyState(
	props: Omit<StateViewProps, "icon" | "role"> & { icon?: JSX.Element },
) {
	return (
		<StateView
			{...props}
			icon={
				props.icon ?? (
					<Icon name="Inbox" size={16} color={token("muted-foreground")} />
				)
			}
		/>
	);
}

/**
 * A failure (React's `ErrorState`), announced as an alert. With `onRetry`
 * an outline Retry button shows, disabled while its promise runs. Callers
 * own the copy (`common.loadFailed`, `common.retry`).
 */
export function ErrorState(
	props: Omit<StateViewProps, "icon" | "role" | "action"> & {
		onRetry?: () => Promise<void> | void;
		/** The caller's Retry copy. */
		retryLabel?: StateText;
		retryTestID?: string;
	},
) {
	const retrying = signal(false);
	const retry = async () => {
		retrying.set(true);
		try {
			await props.onRetry?.();
		} finally {
			retrying.set(false);
		}
	};
	return (
		<StateView
			{...props}
			role="alert"
			icon={
				<Icon name="CircleAlert" size={16} color={token("muted-foreground")} />
			}
			action={
				props.onRetry ? (
					<Button
						testID={props.retryTestID}
						variant="outline"
						size="sm"
						disabled={retrying()}
						onPress={() => void retry()}
					>
						<Text class="font-sans">{props.retryLabel ?? "Retry"}</Text>
					</Button>
				) : undefined
			}
		/>
	);
}
