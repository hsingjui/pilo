import { split, Text, token, View, type JSX } from "nsh";
import {
	Toast as BaseToast,
	type ToastProps as BaseToastProps,
} from "nsh/base";
import { ToastCloseButton } from "./toast-close-button";
import { classNames } from "./class-names";
import { Foreground } from "./foreground";
import { Icon, type IconName } from "./icon";
import { toastMotionProps } from "./motion";
import { styleVar } from "./theme-style";

const variants = {
	default: { icon: null, foreground: "popover-foreground" },
	success: { icon: "CircleCheck", foreground: "status-success" },
	info: { icon: "Info", foreground: "muted-foreground" },
	warning: { icon: "TriangleAlert", foreground: "status-warning" },
	error: { icon: "CircleAlert", foreground: "status-danger" },
} as const satisfies Record<
	string,
	{ icon: IconName | null; foreground: string }
>;

export interface ToastProps extends BaseToastProps {
	variant?: keyof typeof variants;
	description?: string;
	action?: JSX.Element;
	icon?: JSX.Element;
	closeButton?: boolean;
	closeLabel?: string;
	/** Touch/mobile presentation: mobile radius, upward swipe dismiss, always-visible close control. */
	touch?: boolean;
}

export function Toast(props: ToastProps) {
	const [local, rest] = split(props, [
		"class",
		"style",
		"startingClass",
		"endingClass",
		"swipingClass",
		"swipeDirection",
		"swipeThreshold",
		"children",
		"variant",
		"description",
		"action",
		"icon",
		"closeButton",
		"closeLabel",
		"touch",
		"onDismissRequest",
	]);
	const variant = () => variants[local.variant ?? "default"];
	const motion = () => toastMotionProps();
	return (
		<BaseToast
			{...rest}
			swipeDirection={
				local.swipeDirection === undefined
					? local.touch
						? "up"
						: undefined
					: local.swipeDirection
			}
			swipeThreshold={local.swipeThreshold ?? (local.touch ? 28 : undefined)}
			onDismissRequest={local.onDismissRequest}
			class={classNames(
				"group flex-row items-center gap-2.5 border border-border/80 bg-popover text-popover-foreground py-2.5 font-sans text-sm text-(length:--pilo-ui-text-sm) leading-snug",
				local.touch && local.closeButton !== false && local.onDismissRequest
					? "pl-3.5 pr-2"
					: "px-3.5",
				local.touch
					? "rounded-(--pilo-mobile-radius-xl)"
					: "rounded-(--pilo-radius-xl)",
				local.class,
			)}
			style={[
				motion().style,
				{ boxShadow: styleVar("pilo-shadow-panel") },
				local.style,
			]}
			startingClass={classNames(motion().startingClass, local.startingClass)}
			endingClass={classNames(motion().endingClass, local.endingClass)}
			swipingClass={classNames(motion().swipingClass, local.swipingClass)}
		>
			<Foreground.Provider value={() => token(variant().foreground)}>
				{() => {
					const name = variant().icon;
					return (
						local.icon ?? (name ? <Icon name={name} class="shrink-0" /> : null)
					);
				}}
			</Foreground.Provider>
			<View class="flex-1 min-w-0 gap-0.5">
				<View class="font-medium text-popover-foreground text-sm text-(length:--pilo-ui-text-sm) leading-snug">
					{local.children}
				</View>
				{() =>
					local.description ? (
						<Text class="font-sans text-xs text-(length:--pilo-ui-text-xs) text-muted-foreground leading-snug tabular-nums">
							{local.description}
						</Text>
					) : null
				}
			</View>
			{local.action}
			{() =>
				local.closeButton !== false && local.onDismissRequest ? (
					<ToastCloseButton
						touch={local.touch}
						accessibilityLabel={local.closeLabel ?? "Dismiss notification"}
						onPress={local.onDismissRequest}
					/>
				) : null
			}
		</BaseToast>
	);
}
