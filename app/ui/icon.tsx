import { Canvas, Path2D, computed, type CanvasProps } from "nsh";
import icons from "../shell/lucide-icons.json";
import { Foreground } from "./foreground";

export type IconName = keyof typeof icons;

export interface IconProps extends Pick<
	CanvasProps,
	"class" | "style" | "testID" | "ref"
> {
	name: IconName;
	size?: number;
	color?: string;
	strokeWidth?: number;
	/** Fills every path too, as Lucide's `fill-current`. */
	fill?: boolean;
	accessibilityLabel?: string;
}

export function Icon(props: IconProps) {
	if (!icons[props.name]) throw new RangeError(`Unknown icon: ${props.name}`);
	const icon = computed(() => {
		const entry = icons[props.name];
		if (!entry) throw new RangeError(`Unknown icon: ${props.name}`);
		return entry;
	});
	const foreground = Foreground();
	const paths = computed(() =>
		icon().paths.map((entry: { d: string; fill?: boolean }) => ({
			path: new Path2D(entry.d),
			fill: entry.fill,
		})),
	);
	return (
		<Canvas
			class={props.class}
			testID={props.testID}
			ref={props.ref}
			style={[
				{
					width: props.size ?? 16,
					height: props.size ?? 16,
					flexShrink: 0,
				},
				props.style,
			]}
			accessible={!!props.accessibilityLabel}
			accessibilityLabel={props.accessibilityLabel}
			accessibilityElementsHidden={!props.accessibilityLabel}
			draw={(cx, size) => {
				cx.scale(size.width / icon().size, size.height / icon().size);
				cx.strokeStyle = props.color ?? foreground();
				cx.fillStyle = props.color ?? foreground();
				cx.lineWidth = props.strokeWidth ?? 2;
				cx.lineCap = "round";
				cx.lineJoin = "round";
				for (const { path, fill } of paths()) {
					if (fill || props.fill) cx.fill(path);
					cx.stroke(path);
				}
			}}
		/>
	);
}
