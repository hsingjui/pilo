import { Canvas, Path2D, token } from "nsh";

/** Pi's mark, the paths of the WebUI's PiLogo (viewBox 800). */
const PI_LOGO_PATHS = [
	"M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z",
	"M517.36 400H634.72V634.72H517.36Z",
].map((d) => new Path2D(d));

const PI_LOGO_OPTICAL_OFFSET = 120;
const PI_LOGO_OPTICAL_EXTENT = 560;

export function PiLogo(props: {
	size?: number;
	color?: string;
	/** Crop the outer padding of the 800×800 viewBox to match standard icon optical bounds. */
	trim?: boolean;
}) {
	return (
		<Canvas
			style={{ width: props.size ?? 16, height: props.size ?? 16 }}
			accessible={false}
			draw={(cx, size) => {
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
