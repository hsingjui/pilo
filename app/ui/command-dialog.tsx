import { split, token, windowSize } from "nsh";
import { Dialog as BaseDialog, type DialogProps } from "nsh/base";
import { classNames } from "./class-names";
import { styleVar } from "./theme-style";

export type { DialogProps as CommandDialogProps } from "nsh/base";

export function CommandDialog(props: DialogProps) {
	const [local, rest] = split(props, [
		"class",
		"style",
		"backdropClass",
		"backdropStyle",
		"animation",
	]);
	return (
		<BaseDialog
			{...rest}
			animation={local.animation ?? "fade"}
			class={classNames(
				"self-center mb-auto overflow-hidden rounded-(--pilo-radius-xl) border border-border bg-popover text-popover-foreground font-sans",
				local.class,
			)}
			style={[
				{
					width: Math.max(0, Math.min(640, windowSize().width - 48)),
					height: Math.max(0, Math.min(560, windowSize().height * 0.72)),
					marginTop: windowSize().height * 0.12,
					boxShadow: styleVar("pilo-shadow-popover"),
					zIndex: token("z-dialog"),
				},
				local.style,
			]}
			backdropClass={classNames("bg-black/30", local.backdropClass)}
			backdropStyle={[
				{ zIndex: token("z-dialog-overlay") },
				local.backdropStyle,
			]}
		/>
	);
}
