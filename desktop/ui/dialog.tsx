import { Scroll, split, token, windowSize } from "nsh";
import { Dialog as BaseDialog, type DialogProps } from "nsh/base";
import { classNames } from "./class-names";
import { styleVar } from "./theme-style";
import { scrollbarLook } from "./scrollbar";

export type { DialogProps } from "nsh/base";
export function Dialog(props: DialogProps) {
	const [local, rest] = split(props, [
		"class",
		"style",
		"backdropClass",
		"backdropStyle",
		"animation",
		"children",
	]);
	return (
		<BaseDialog
			{...rest}
			animation={local.animation ?? "fade"}
			class={classNames(
				"w-[90%] max-w-lg self-center my-auto overflow-hidden rounded-(--pilo-radius-lg) border border-border bg-background text-foreground font-sans",
				local.class,
			)}
			style={[
				{
					maxHeight: Math.max(0, windowSize().height - 32),
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
		>
			<Scroll
				class="min-h-0 shrink"
				contentClass="p-(--pilo-dialog-padding) gap-(--pilo-dialog-gap)"
				scrollbar={{ mode: "always", vertical: scrollbarLook() }}
			>
				{local.children}
			</Scroll>
		</BaseDialog>
	);
}
