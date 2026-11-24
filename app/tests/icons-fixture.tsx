import {
	Canvas,
	Path2D,
	Text,
	View,
	mount,
	signal,
	type CanvasRenderingContext2D,
} from "nsh";
import { Button } from "nsh/base";
import icons from "../shell/lucide-icons.json";

type Icon = { size: number; paths: { d: string; fill?: boolean }[] };

function prepareIcon({ size, paths }: Icon) {
	return {
		size,
		paths: paths.map(({ d, fill }) => ({ path: new Path2D(d), fill })),
	};
}

const catalog = Object.fromEntries(
	Object.entries(icons).map(([name, icon]) => [name, prepareIcon(icon)]),
);
const samples = [
	{
		icon: catalog.CircleAlert,
		points: [
			[2, 12],
			[12, 10],
		],
	},
	{
		icon: catalog.PanelLeft,
		points: [
			[3, 12],
			[9, 11],
		],
	},
	{ icon: catalog.Inbox, points: [[12, 15]] },
	{
		icon: catalog.Palette,
		points: [
			[12, 2],
			[13.5, 6.5],
		],
	},
] as const;
const contexts: CanvasRenderingContext2D[] = [];
const result = signal("Not checked");

function check() {
	const correct = samples.every(({ icon, points }, i) => {
		const cx = contexts[i];
		if (!cx) return false;
		return points.every(([x, y], index) => {
			const { path, fill } = icon.paths[index];
			return fill
				? cx.isPointInPath(path, x, y) && !cx.isPointInPath(path, 0, 0)
				: cx.isPointInStroke(path, x, y) && !cx.isPointInStroke(path, 0, 0);
		});
	});
	result.set(correct ? "Icon geometry ready" : "Incorrect icon geometry");
}

mount(() => (
	<View>
		<View style={{ flexDirection: "row" }}>
			{samples.map(({ icon }, i) => (
				<Canvas
					style={{ width: icon.size, height: icon.size }}
					draw={(cx) => {
						contexts[i] = cx;
						cx.strokeStyle = "black";
						cx.fillStyle = "black";
						cx.lineWidth = 2;
						cx.lineCap = "round";
						cx.lineJoin = "round";
						for (const { path, fill } of icon.paths) {
							if (fill) cx.fill(path);
							cx.stroke(path);
						}
					}}
				/>
			))}
		</View>
		<Button onPress={check}>
			<Text>Check icons</Text>
		</Button>
		<Text>{result}</Text>
	</View>
));
