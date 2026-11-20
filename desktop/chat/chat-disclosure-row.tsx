import { split, token, View, type ViewProps } from "nsh";

import { classNames } from "../ui/class-names";
import { focusRingStyle } from "../ui/focus-ring-style";
import { Foreground } from "../ui/foreground";

export interface ChatDisclosureRowProps extends Omit<ViewProps, "onPress"> {
	/** Whether what it discloses shows; `undefined` for a row with nothing to disclose. */
	expanded?: boolean;
	/** The row's text and icons color: muted, or destructive for a failure. */
	tone?: "muted" | "destructive";
	onPress?: () => void;
}

/**
 * A row of a reply's work that opens what it summarizes (the WebUI's
 * process rows): full width, muted, a hover background. It is the
 * disclosure's trigger as `Collapsible` describes one, a view with the
 * button role that takes the press and tells screen readers whether it is
 * expanded (`nsh/base`'s `Button` has no expanded state). A row with
 * nothing to open is disabled and shows no hover.
 */
export function ChatDisclosureRow(props: ChatDisclosureRowProps) {
	const [local, rest] = split(props, [
		"expanded",
		"tone",
		"class",
		"disabled",
		"onPress",
		"children",
	]);
	const color = () =>
		token(local.tone === "destructive" ? "destructive" : "muted-foreground");
	return (
		<Foreground.Provider value={color}>
			<View
				{...rest}
				role="button"
				disabled={local.disabled}
				accessibilityState={
					local.expanded === undefined
						? { disabled: local.disabled }
						: { expanded: local.expanded, disabled: local.disabled }
				}
				class={classNames(
					"-mx-1 min-h-6 flex-row items-center gap-1.5 rounded-(--pilo-radius-md) px-1 py-0.5",
					local.disabled ? undefined : "hover:bg-hover",
					local.class,
				)}
				focusVisibleStyle={focusRingStyle(token("ring"), undefined, undefined, {
					width: 2,
				})}
				onPress={() => local.onPress?.()}
			>
				{local.children}
			</View>
		</Foreground.Provider>
	);
}
