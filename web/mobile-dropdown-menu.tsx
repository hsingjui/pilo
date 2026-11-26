import {
	context,
	signal,
	split,
	token,
	View,
	windowSize,
	type JSX,
	type StyleProp,
	type ViewStyle,
} from "nsh";
import {
	MenuItem as BaseMenuItem,
	Popover as BasePopover,
	type PopoverProps,
} from "nsh/base";

import { classNames } from "../app/ui/class-names";
import { Foreground } from "../app/ui/foreground";
import { Icon } from "../app/ui/icon";
import { menuPopupStyle } from "../app/ui/menu";
import { menuRowClass } from "../app/ui/menu-row";
import {
	popupMotionStyles,
	springTransition,
	tactileTransition,
} from "../app/ui/motion";

const DropdownClose = context<() => void>(() => undefined);

export interface MobileDropdownMenuProps extends Omit<
	PopoverProps,
	"open" | "onOpenChange"
> {
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}

/**
 * Anchored dropdown menu for nsh Web (`web/`).
 *
 * Unlike `nsh/base`'s `Menu` — which turns into a bottom sheet on phone/compact
 * idioms and leaves fixed-width menus stranded at the bottom-left corner —
 * `Popover` always anchors directly to its trigger across phone, tablet, and
 * desktop idioms while keeping outside-tap and Escape dismissal.
 */
export function MobileDropdownMenu(props: MobileDropdownMenuProps) {
	const [local, rest] = split(props, [
		"open",
		"onOpenChange",
		"placement",
		"align",
		"offset",
		"margin",
		"popupClass",
		"popupStyle",
		"children",
	]);
	const internalOpen = signal(false);
	const isOpen = () => local.open ?? internalOpen();
	const setOpen = (next: boolean) => {
		if (local.open === undefined) internalOpen.set(next);
		local.onOpenChange?.(next);
	};

	const motion = () => popupMotionStyles();
	return (
		<BasePopover
			{...rest}
			open={isOpen()}
			onOpenChange={({ open }) => setOpen(open)}
			placement={local.placement ?? "bottom"}
			align={local.align ?? "end"}
			offset={local.offset ?? 6}
			margin={local.margin ?? 8}
			popupClass={classNames(
				"rounded-(--pilo-menu-radius) bg-(--pilo-menu-background) text-foreground p-(--pilo-menu-padding) font-sans",
				local.popupClass,
			)}
			popupStyle={[
				menuPopupStyle(),
				{ maxWidth: Math.max(200, windowSize().width - 16) },
				local.popupStyle,
			]}
			popupStartingStyle={motion().popupStartingStyle}
			popupEndingStyle={motion().popupEndingStyle}
		>
			<DropdownClose.Provider value={() => setOpen(false)}>
				<View role="menu" class="gap-(--pilo-menu-item-gap)">
					{local.children}
				</View>
			</DropdownClose.Provider>
		</BasePopover>
	);
}

export interface MobileDropdownItemProps {
	testID?: string;
	class?: string;
	style?: StyleProp<ViewStyle>;
	icon?: JSX.Element;
	checked?: boolean;
	role?: "menuitemradio";
	variant?: "default" | "destructive";
	disabled?: boolean;
	closeOnSelect?: boolean;
	accessibilityLabel?: string;
	onSelect?: () => void;
	children?: JSX.Element;
}

export function MobileDropdownItem(props: MobileDropdownItemProps) {
	const close = DropdownClose();
	const foreground = () =>
		token(props.variant === "destructive" ? "destructive" : "foreground");
	const iconForeground = () =>
		token(props.variant === "destructive" ? "destructive" : "muted-foreground");

	return (
		<Foreground.Provider value={foreground}>
			<BaseMenuItem
				testID={props.testID}
				role={props.role}
				checked={props.checked}
				disabled={props.disabled}
				closeOnSelect={false}
				accessibilityLabel={props.accessibilityLabel}
				class={classNames(
					menuRowClass,
					"min-h-11 active:bg-hover",
					props.variant === "destructive" &&
						"text-destructive hover:text-destructive focus:text-destructive hover:bg-destructive/10 focus:bg-destructive/10 active:bg-destructive/15",
					props.class,
				)}
				style={[tactileTransition("background-color, color"), props.style]}
				onSelect={() => {
					if (props.disabled) return;
					props.onSelect?.();
					if (props.closeOnSelect !== false) close();
				}}
			>
				{props.checked !== undefined ? (
					<View
						class="size-3.5 shrink-0 items-center justify-center"
						style={[
							springTransition("opacity, transform", "crisp"),
							props.checked
								? { opacity: 1, transform: [{ scale: 1 }] }
								: { opacity: 0, transform: [{ scale: 0.7 }] },
						]}
					>
						<Icon name="Check" size={14} color={foreground()} />
					</View>
				) : null}
				{props.icon ? (
					<Foreground.Provider value={iconForeground}>
						{props.icon}
					</Foreground.Provider>
				) : null}
				{props.children}
			</BaseMenuItem>
		</Foreground.Provider>
	);
}
