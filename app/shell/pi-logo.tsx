import { Canvas, Path2D, token } from "nsh";

/** Pi's mark, the paths of the WebUI's PiLogo (viewBox 800). */
const PI_LOGO_PATHS = [
	"M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z",
	"M517.36 400H634.72V634.72H517.36Z",
].map((d) => new Path2D(d));

const PI_LOGO_OPTICAL_OFFSET = 120;
const PI_LOGO_OPTICAL_EXTENT = 560;

/** Official tricolor brand blocks from `assets/branding/icon.svg` (viewBox 512, bounds 112..400). */
const PI_COLOR_LAYERS = [
	{
		color: "#ED6C5D",
		path: new Path2D("M112 112 H328 V256 H256 V184 H112 Z"),
	},
	{
		color: "#3183B7",
		path: new Path2D("M112 184 H184 V256 H256 V328 H184 V400 H112 Z"),
	},
	{
		color: "#EEB235",
		path: new Path2D("M328 256 H400 V400 H328 Z"),
	},
] as const;

const PI_COLOR_OFFSET = 112;
const PI_COLOR_EXTENT = 288;

export function PiLogo(props: {
	size?: number;
	color?: string;
	/** Render the official coral/blue/gold geometric brand mark instead of monochrome. */
	colorized?: boolean;
	/** Crop the outer padding of the viewBox to match standard icon optical bounds. */
	trim?: boolean;
}) {
	return (
		<Canvas
			style={{ width: props.size ?? 16, height: props.size ?? 16 }}
			accessible={false}
			draw={(cx, size) => {
				if (props.colorized) {
					if (props.trim) {
						cx.scale(
							size.width / PI_COLOR_EXTENT,
							size.height / PI_COLOR_EXTENT,
						);
						cx.translate(-PI_COLOR_OFFSET, -PI_COLOR_OFFSET);
					} else {
						cx.scale(size.width / 512, size.height / 512);
					}
					for (const layer of PI_COLOR_LAYERS) {
						cx.fillStyle = layer.color;
						cx.fill(layer.path);
					}
					return;
				}
				if (props.trim) {
					cx.scale(
						size.width / PI_LOGO_OPTICAL_EXTENT,
						size.height / PI_LOGO_OPTICAL_EXTENT,
					);
					cx.translate(-PI_LOGO_OPTICAL_OFFSET, -PI_LOGO_OPTICAL_OFFSET);
				} else {
					cx.scale(size.width / 800, size.height / 800);
				}
				cx.fillStyle = props.color ?? token("muted-foreground");
				for (const path of PI_LOGO_PATHS) cx.fill(path, "evenodd");
			}}
		/>
	);
}
