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

type CachedIconPath = { readonly path: Path2D; readonly fill?: boolean };

const iconPathCache = new Map<IconName, readonly CachedIconPath[]>();

export function cachedIconPaths(name: IconName): readonly CachedIconPath[] {
	const hit = iconPathCache.get(name);
	if (hit) return hit;
	const entry = icons[name];
	if (!entry) throw new RangeError(`Unknown icon: ${name}`);
	const parsed = entry.paths.map((item: { d: string; fill?: boolean }) => ({
		path: new Path2D(item.d),
		fill: item.fill,
	}));
	iconPathCache.set(name, parsed);
	return parsed;
}

export function Icon(props: IconProps) {
	if (!icons[props.name]) throw new RangeError(`Unknown icon: ${props.name}`);
	const icon = computed(() => {
		const entry = icons[props.name];
		if (!entry) throw new RangeError(`Unknown icon: ${props.name}`);
		return entry;
	});
	const foreground = Foreground();
	const paths = computed(() => cachedIconPaths(props.name));
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
