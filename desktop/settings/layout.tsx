import type { JSX } from "nsh";
import { Text, View } from "nsh";

import { classNames } from "../ui/class-names";

/** A bordered card with an optional header, as `SettingsSection` in Tauri. */
export function SettingsSection(props: {
	title?: string;
	headerRight?: JSX.Element;
	children: JSX.Element;
	class?: string;
	testID?: string;
}) {
	return (
		<View
			testID={props.testID}
			class={classNames(
				"overflow-hidden rounded-lg border border-border/70 bg-card/60 text-sm",
				props.class,
			)}
		>
			{() =>
				props.title || props.headerRight ? (
					<View class="min-h-10 flex-row items-center justify-between gap-2 border-b border-border/70 bg-muted/40 px-3 py-1.5">
						<View class="min-w-0 flex-1">
							{props.title ? (
								<Text class="text-xs font-semibold text-muted-foreground">
									{props.title}
								</Text>
							) : null}
						</View>
						{props.headerRight ?? null}
					</View>
				) : null
			}
			<View>{props.children}</View>
		</View>
	);
}

/** A label and helper on the left, controls on the right. */
export function SettingsRow(props: {
	label: string;
	helper?: string;
	children?: JSX.Element;
	class?: string;
}) {
	return (
		<View
			class={classNames(
				"gap-2 px-3 py-2 flex-col border-b border-border/60 last:border-b-0",
				props.class,
			)}
		>
			<View class="flex-row items-center gap-4">
				<View class="min-w-0 flex-1">
					<Text class="font-medium leading-tight text-foreground">
						{props.label}
					</Text>
				</View>
				{props.children ? (
					<View class="min-w-0 shrink-0 flex-row items-center gap-2">
						{props.children}
					</View>
				) : null}
			</View>
			{props.helper ? (
				<Text class="text-xs leading-[1.4] text-muted-foreground">
					{props.helper}
				</Text>
			) : null}
		</View>
	);
}

/** A small bordered status chip, as `SettingsStatus` in Tauri. */
export function SettingsStatus(props: {
	muted?: boolean;
	children: JSX.Element;
}) {
	return (
		<View
			class={classNames(
				"h-6 flex-row items-center rounded-md border px-2",
				props.muted
					? "border-border/60 bg-muted/35"
					: "border-border/70 bg-background",
			)}
		>
			<Text
				class={classNames(
					"text-[10px] font-medium",
					props.muted ? "text-muted-foreground" : "text-foreground/80",
				)}
			>
				{props.children}
			</Text>
		</View>
	);
}

/** The pane a tab has while its settings still wait on the bridge. */
export function PendingPane(props: { detail?: string }) {
	return (
		<View class="rounded-lg border border-dashed border-border/70 px-4 py-8">
			<Text class="text-center text-sm text-muted-foreground">
				{() => props.detail ?? ""}
			</Text>
		</View>
	);
}
