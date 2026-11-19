import { split, Text, token, View, type JSX } from "nsh";
import {
	Toast as BaseToast,
	type ToastProps as BaseToastProps,
} from "nsh/base";
import { Button } from "./button";
import { classNames } from "./class-names";
import { Foreground } from "./foreground";
import { Icon, type IconName } from "./icon";
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
	icon?: JSX.Element;
	closeButton?: boolean;
	closeLabel?: string;
}

export function Toast(props: ToastProps) {
	const [local, rest] = split(props, [
		"class",
		"style",
		"children",
		"variant",
		"description",
		"icon",
		"closeButton",
		"closeLabel",
		"onDismissRequest",
	]);
	const variant = () => variants[local.variant ?? "default"];
	return (
		<BaseToast
			{...rest}
			onDismissRequest={local.onDismissRequest}
			class={classNames(
				"group flex-row items-start gap-2.5 rounded-(--pilo-floating-radius) border border-border bg-popover text-popover-foreground px-3.5 py-3 font-sans text-sm leading-snug",
				local.class,
			)}
			style={[{ boxShadow: styleVar("pilo-shadow-floating") }, local.style]}
		>
			<Foreground.Provider value={() => token(variant().foreground)}>
				{() => {
					const name = variant().icon;
					return (
						local.icon ?? (name ? <Icon name={name} class="mt-0.5" /> : null)
					);
				}}
			</Foreground.Provider>
			<View class="flex-1 min-w-0 gap-0.5">
				<View class="font-medium text-popover-foreground leading-5">
					{local.children}
				</View>
				{() =>
					local.description ? (
						<Text class="text-xs text-muted-foreground leading-4">
							{local.description}
						</Text>
					) : null
				}
			</View>
			{() =>
				local.closeButton !== false && local.onDismissRequest ? (
					<Button
						variant="ghost"
						size="icon"
						class="size-5 p-0 text-muted-foreground hover:text-popover-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
						accessibilityLabel={local.closeLabel ?? "Dismiss notification"}
						onPress={local.onDismissRequest}
					>
						<Icon name="X" size={14} color={token("muted-foreground")} />
					</Button>
				) : null
			}
		</BaseToast>
	);
}
