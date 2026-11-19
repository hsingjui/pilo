import { split, token } from "nsh";
import { ToastStack as BaseToastStack, type ToastStackProps } from "nsh/base";
import { classNames } from "./class-names";

export { ToastManager } from "nsh/base";
export type {
	ToastStackProps,
	ToastEntry,
	ToastOptions,
	ToastMotion,
} from "nsh/base";

export function ToastStack(props: ToastStackProps) {
	const [local, rest] = split(props, ["class", "style", "placement"]);
	return (
		<BaseToastStack
			{...rest}
			placement={local.placement ?? "topCenter"}
			class={classNames("w-96 max-w-full", local.class)}
			style={[{ zIndex: token("z-toast") }, local.style]}
		/>
	);
}
