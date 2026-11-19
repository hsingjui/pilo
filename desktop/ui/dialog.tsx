import { split, token } from "nsh";
import { Dialog as BaseDialog, type DialogProps } from "nsh/base";
import { classNames } from "./class-names";
import { styleVar } from "./theme-style";

export type { DialogProps } from "nsh/base";
export function Dialog(props: DialogProps) {
	const [local, rest] = split(props, [
		"class",
		"style",
		"backdropClass",
		"backdropStyle",
	]);
	return (
		<BaseDialog
			{...rest}
			class={classNames(
				"w-[90%] max-w-lg self-center my-auto rounded-(--pilo-radius-lg) border border-border bg-background text-foreground p-(--pilo-dialog-padding) gap-(--pilo-dialog-gap) font-sans",
				local.class,
			)}
			style={[
				{
					boxShadow: styleVar("pilo-shadow-popover"),
					zIndex: token("z-dialog"),
				},
				local.style,
			]}
			backdropClass={classNames("bg-black/40", local.backdropClass)}
			backdropStyle={[
				{ zIndex: token("z-dialog-overlay") },
				local.backdropStyle,
			]}
		/>
	);
}
