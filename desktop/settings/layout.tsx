import type { JSX } from "nsh";
import { Text, View, windowSize } from "nsh";

import { classNames } from "../ui/class-names";

/** Tailwind's sm:, measured on the window as the WebUI's viewport. */
const SM_WIDTH = 640;

const narrow = () => windowSize().width < SM_WIDTH;

/*
 * Settings rows use the WebUI's compact 32pt controls: `size="sm"` on Input,
 * Select and NumberInput, and these classes on Buttons beside them, so a
 * row's fields and buttons share one height.
 */
/** A ghost icon button in a settings row (refresh, reveal, row actions). */
export const SETTINGS_ICON_BUTTON_CLASS =
	"size-(--pilo-button-sm-height) shrink-0";
/** A ghost text button in a settings row: a 14pt icon and a short label. */
export const SETTINGS_TEXT_BUTTON_CLASS =
	"h-(--pilo-button-sm-height) gap-1.5 px-2 text-xs font-normal";
/** An icon button in a SettingsSection header, as the WebUI's 28pt header actions. */
export const SETTINGS_HEADER_ICON_BUTTON_CLASS = "size-7 shrink-0";

/** A bordered card with an optional header, as `SettingsSection` in the WebUI. */
export function SettingsSection(props: {
	title?: string;
	/** Muted text on the header's right (a count, a scope summary). */
	headerRight?: JSX.Element;
	/** Interactive controls on the header's right (buttons, pickers). */
	actions?: JSX.Element;
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
				props.title || props.headerRight || props.actions ? (
					<View class="min-h-10 flex-row items-center justify-between gap-2 border-b border-border/70 bg-muted/40 px-3 py-1.5">
						<View class="min-w-0 flex-1">
							{props.title ? (
								<Text class="font-sans text-xs font-semibold leading-tight text-muted-foreground">
									{props.title}
								</Text>
							) : null}
						</View>
						{props.headerRight ? (
							<View class="min-w-0 shrink-0 flex-row items-center justify-end">
								{props.headerRight}
							</View>
						) : null}
						{props.actions ? (
							<View class="shrink-0 flex-row items-center gap-1.5">
								{props.actions}
							</View>
						) : null}
					</View>
				) : null
			}
			<View>{props.children}</View>
		</View>
	);
}

/**
 * A label and helper on the left, controls on the right. Rows stack under
 * sm: the controls sit under the label, flush left; at sm: they right-align
 * in a `minmax(0,1fr) auto` track, as `SettingsRow` in the WebUI.
 */
export function SettingsRow(props: {
	label: string;
	helper?: string;
	children?: JSX.Element;
	class?: string;
	/**
	 * Ghost buttons lose their own padding to the row's edge, as the WebUI's
	 * `[data-button-variant=ghost]` compensation: `"end"` for a ghost last
	 * control (-mr-2 at sm:), `"both"` when the controls are a single ghost
	 * button (also -ml-2 under sm:). The margin goes on the controls box, so
	 * `"end"` is only exact when the ghost is the outermost last child.
	 */
	ghostEdge?: "end" | "both";
}) {
	const controls = () =>
		props.children ? (
			<View
				class={classNames(
					"min-w-0 flex-row flex-wrap items-center gap-2 text-sm",
					narrow() ? "w-full" : "shrink-0 justify-end pl-4",
				)}
				style={{
					marginLeft: narrow() && props.ghostEdge === "both" ? -8 : 0,
					marginRight: !narrow() && props.ghostEdge ? -8 : 0,
				}}
			>
				{props.children}
			</View>
		) : null;
	const label = (
		<View
			class={classNames(
				"min-w-0",
				!narrow() && props.helper ? "max-w-[520px]" : undefined,
				!narrow() && "flex-1",
			)}
		>
			<Text class="font-sans font-medium leading-tight text-foreground">
				{props.label}
			</Text>
			{props.helper ? (
				<Text class="font-sans text-[11px] leading-[1.4] text-muted-foreground">
					{props.helper}
				</Text>
			) : null}
		</View>
	);
	return (
		<View
			class={classNames(
				"gap-2 px-3 py-2 border-b border-border/60 last:border-b-0",
				props.class,
			)}
		>
			{() =>
				narrow() ? (
					<>
						{label}
						{controls()}
					</>
				) : (
					<View class="flex-row items-center gap-4">
						{label}
						{controls()}
					</View>
				)
			}
		</View>
	);
}

/** A small bordered status chip, as `SettingsStatus` in the WebUI. */
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
					"font-sans text-[11px] font-medium",
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
			<Text class="font-sans text-center text-sm text-muted-foreground">
				{() => props.detail ?? ""}
			</Text>
		</View>
	);
}
