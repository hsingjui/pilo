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
	Button as BaseButton,
	Popover as BasePopover,
	type PopoverProps,
} from "nsh/base";

import { classNames } from "../ui/class-names";
import { Foreground } from "../ui/foreground";
import { Icon } from "../ui/icon";
import { menuPopupStyle } from "../ui/menu";
import { menuRowClass } from "../ui/menu-row";

const DropdownClose = context<() => void>(() => undefined);

export interface MobileDropdownMenuProps extends Omit<
	PopoverProps,
	"open" | "onOpenChange"
> {
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}

/**
 * Anchored dropdown menu for nsh Web (`desktop/mobile`).
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
				"rounded-(--pilo-menu-radius) bg-(--pilo-menu-background) text-foreground p-(--pilo-menu-padding) gap-(--pilo-menu-item-gap) font-sans",
				local.popupClass,
			)}
			popupStyle={[
				menuPopupStyle(),
				{ maxWidth: Math.max(200, windowSize().width - 16) },
				local.popupStyle,
			]}
		>
			<DropdownClose.Provider value={() => setOpen(false)}>
				{local.children}
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
			<BaseButton
				testID={props.testID}
				role={props.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
				selected={props.checked}
				disabled={props.disabled}
				accessibilityLabel={props.accessibilityLabel}
				class={classNames(
					menuRowClass,
					"min-h-11",
					props.variant === "destructive" &&
						"text-destructive hover:text-destructive focus:text-destructive hover:bg-destructive/10 focus:bg-destructive/10",
					props.class,
				)}
				style={props.style}
				onPress={() => {
					if (props.disabled) return;
					props.onSelect?.();
					if (props.closeOnSelect !== false) close();
				}}
			>
				{props.checked !== undefined ? (
					<View
						class={classNames(
							"size-3.5 shrink-0 items-center justify-center",
							props.checked ? "opacity-100" : "opacity-0",
						)}
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
			</BaseButton>
		</Foreground.Provider>
	);
}
