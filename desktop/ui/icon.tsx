import { Canvas, Path2D, type CanvasProps } from "nsh";
import icons from "../app/lucide-icons.json";
import { Foreground } from "./foreground";

export type IconName = keyof typeof icons;

export interface IconProps extends Pick<
	CanvasProps,
	"class" | "testID" | "ref"
> {
	name: IconName;
	size?: number;
	color?: string;
	accessibilityLabel?: string;
}

export function Icon(props: IconProps) {
	const icon = icons[props.name];
	if (!icon) throw new RangeError(`Unknown icon: ${props.name}`);
	const foreground = Foreground();
	const paths = icon.paths.map((entry: { d: string; fill?: boolean }) => ({
		path: new Path2D(entry.d),
		fill: entry.fill,
	}));
	return (
		<Canvas
			class={props.class}
			testID={props.testID}
			ref={props.ref}
			style={{
				width: props.size ?? 16,
				height: props.size ?? 16,
				flexShrink: 0,
			}}
			accessible={!!props.accessibilityLabel}
			accessibilityLabel={props.accessibilityLabel}
			accessibilityElementsHidden={!props.accessibilityLabel}
			draw={(cx, size) => {
				cx.scale(size.width / icon.size, size.height / icon.size);
				cx.strokeStyle = props.color ?? foreground();
				cx.fillStyle = props.color ?? foreground();
				cx.lineWidth = 2;
				cx.lineCap = "round";
				cx.lineJoin = "round";
				for (const { path, fill } of paths) {
					if (fill) cx.fill(path);
					cx.stroke(path);
				}
			}}
		/>
	);
}
