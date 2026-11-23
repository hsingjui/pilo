import type { JSX } from "nsh";
import { split, Text, token, View, windowSize } from "nsh";

import { t } from "../app/i18n";
import { Button, type ButtonProps } from "../ui/button";
import { classNames } from "../ui/class-names";
import { Foreground } from "../ui/foreground";
import { createHover } from "../ui/hover";
import { Icon, type IconName } from "../ui/icon";
import { textTooltip } from "../ui/tooltip";

/** Tailwind's sm:, measured on the window as the WebUI's viewport. */
export const SETTINGS_SM_WIDTH = 640;

export const isNarrowSettings = () => windowSize().width < SETTINGS_SM_WIDTH;

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
	"h-(--pilo-button-sm-height) gap-1.5 px-2 py-0 text-xs font-normal";
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
	label: string | JSX.Element;
	helper?: string | JSX.Element;
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
					isNarrowSettings() ? "w-full" : "shrink-0 justify-end pl-4",
				)}
				style={{
					marginLeft: isNarrowSettings() && props.ghostEdge === "both" ? -8 : 0,
					marginRight: !isNarrowSettings() && props.ghostEdge ? -8 : 0,
				}}
			>
				{props.children}
			</View>
		) : null;
	const label = (
		<View
			class={classNames(
				"min-w-0",
				!isNarrowSettings() && props.helper ? "max-w-[520px]" : undefined,
				!isNarrowSettings() && "flex-1",
			)}
		>
			{() =>
				typeof props.label === "string" ? (
					<Text class="font-sans font-medium leading-tight text-foreground">
						{props.label}
					</Text>
				) : (
					props.label
				)
			}
			{() =>
				props.helper ? (
					typeof props.helper === "string" ? (
						<Text class="font-sans text-[11px] leading-[1.4] text-muted-foreground">
							{props.helper}
						</Text>
					) : (
						props.helper
					)
				) : null
			}
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
				isNarrowSettings() ? (
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
	icon?: IconName;
	children: JSX.Element;
}) {
	return (
		<View
			class={classNames(
				"h-6 flex-row items-center gap-1 rounded-md border px-2",
				props.muted
					? "border-border/60 bg-muted/35"
					: "border-border/70 bg-background",
			)}
		>
			{props.icon ? (
				<Icon
					name={props.icon}
					size={12}
					color={token(props.muted ? "muted-foreground" : "foreground")}
				/>
			) : null}
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

/**
 * A compact settings icon button whose canvas icons follow muted / hover /
 * selected / destructive foreground tokens.
 */
export function SettingsIconButton(
	props: Omit<ButtonProps, "size" | "tooltip"> & {
		tooltip?: string;
		destructive?: boolean;
	},
) {
	const [local, rest] = split(props, [
		"variant",
		"class",
		"tooltip",
		"destructive",
		"children",
	]);
	const hover = createHover();
	const iconColor = () => {
		if (local.destructive && hover.hovered()) return token("destructive");
		if (hover.hovered() || rest.selected) return token("foreground");
		return token("muted-foreground");
	};
	return (
		<Button
			{...rest}
			variant={local.variant ?? "ghost"}
			size="icon"
			class={classNames(
				SETTINGS_ICON_BUTTON_CLASS,
				"text-muted-foreground hover:text-foreground",
				local.destructive && "hover:bg-destructive/10 hover:text-destructive",
				local.class,
			)}
			tooltip={local.tooltip ? textTooltip(local.tooltip) : undefined}
			{...hover.props}
		>
			<Foreground.Provider value={iconColor}>
				{local.children}
			</Foreground.Provider>
		</Button>
	);
}

/**
 * A compact settings text+icon button (`h-8`, `py-0`) whose canvas icons match
 * the muted/hover text foreground.
 */
export function SettingsActionButton(
	props: Omit<ButtonProps, "size" | "tooltip"> & {
		tooltip?: string;
		/** Keep full foreground color instead of muted idle tint. */
		emphasized?: boolean;
	},
) {
	const [local, rest] = split(props, [
		"variant",
		"class",
		"tooltip",
		"emphasized",
		"children",
	]);
	const hover = createHover();
	const muted = () =>
		!local.emphasized && (local.variant ?? "ghost") === "ghost";
	const iconColor = () =>
		!muted() || hover.hovered()
			? token("foreground")
			: token("muted-foreground");
	return (
		<Button
			{...rest}
			variant={local.variant ?? "ghost"}
			size="sm"
			class={classNames(
				SETTINGS_TEXT_BUTTON_CLASS,
				muted() && "text-muted-foreground hover:text-foreground",
				local.class,
			)}
			tooltip={local.tooltip ? textTooltip(local.tooltip) : undefined}
			{...hover.props}
		>
			<Foreground.Provider value={iconColor}>
				{local.children}
			</Foreground.Provider>
		</Button>
	);
}

/** Inline destructive message with a ghost Retry button. */
export function SettingsRetryInline(props: {
	message: string;
	onRetry: () => void;
	disabled?: boolean;
	/** Stretch message to fill the row (used for full-width section notices). */
	fill?: boolean;
	class?: string;
}) {
	return (
		<View
			class={classNames("flex-row flex-wrap items-center gap-2", props.class)}
		>
			<Text
				class={classNames(
					"font-sans text-xs text-destructive",
					props.fill && "min-w-0 flex-1",
				)}
			>
				{props.message}
			</Text>
			<Button
				variant="ghost"
				size="sm"
				disabled={props.disabled}
				onPress={props.onRetry}
			>
				<Text class="font-sans">{t("common.retry")}</Text>
			</Button>
		</View>
	);
}

/** A muted or error message row inside a SettingsSection (loading, empty, failure). */
export function SettingsSectionMessage(props: {
	tone?: "muted" | "error";
	size?: "xs" | "2xs";
	padded?: "compact" | "default" | "roomy";
	bordered?: boolean;
	children: JSX.Element;
}) {
	return (
		<View
			class={classNames(
				"px-3",
				props.padded === "roomy"
					? "py-5"
					: props.padded === "default"
						? "py-3"
						: "py-2",
				props.bordered && "border-b border-border/60 last:border-b-0",
			)}
		>
			<Text
				class={classNames(
					"font-sans",
					props.size === "2xs" ? "text-[11px]" : "text-xs",
					props.tone === "error" ? "text-destructive" : "text-muted-foreground",
				)}
			>
				{props.children}
			</Text>
		</View>
	);
}
