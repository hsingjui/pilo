import { Canvas, split, type CanvasProps } from "nsh";
import icons from "../shell/lucide-icons.json";
import { classNames } from "./class-names";
import { Foreground } from "./foreground";
import { cachedIconPaths } from "./icon";

export interface SpinnerProps extends Pick<
	CanvasProps,
	"class" | "style" | "testID" | "ref" | "accessibilityLabel"
> {
	size?: number;
	color?: string;
}

export function Spinner(props: SpinnerProps) {
	const [local, rest] = split(props, [
		"class",
		"style",
		"size",
		"color",
		"accessibilityLabel",
	]);
	const foreground = Foreground();
	const icon = icons.LoaderCircle;
	const paths = cachedIconPaths("LoaderCircle");
	return (
		<Canvas
			{...rest}
			class={classNames("size-6 shrink-0 animate-spin", local.class)}
			style={[
				local.size === undefined
					? undefined
					: { width: local.size, height: local.size },
				local.style,
			]}
			accessible={!!local.accessibilityLabel}
			accessibilityLabel={local.accessibilityLabel}
			accessibilityElementsHidden={!local.accessibilityLabel}
			draw={(cx, size) => {
				cx.scale(size.width / icon.size, size.height / icon.size);
				cx.strokeStyle = local.color ?? foreground();
				cx.lineWidth = 2;
				cx.lineCap = "round";
				cx.lineJoin = "round";
				for (const { path } of paths) cx.stroke(path);
			}}
		/>
	);
}
