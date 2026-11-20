import {
	Canvas,
	cleanup,
	createMotion,
	type Easing,
	reduceMotion,
	Text,
	token,
	View,
} from "nsh";

// The WebUI's `ease-in-out`.
const easeInOut: Easing = [0.42, 0, 0.58, 1];

/** The primary dot breathing beside the label (3.5s, as the WebUI's). */
function PulsingDot() {
	const motion = createMotion({
		enter: {
			keyframes: { opacity: [0.35, 0.8, 0.35], scale: [0.7, 1, 0.7] },
			duration: 3500,
			easing: easeInOut,
			iterations: "infinite",
		},
	});
	cleanup(() => motion.stop());
	return (
		<View class="size-[34%] rounded-full bg-primary" style={motion.style} />
	);
}

/** Draw the glow without adding a second text node for the label. */
function LabelHighlight(props: { label: string }) {
	const motion = createMotion({
		initial: { opacity: 0, translateX: -1 },
		enter: {
			keyframes: [
				{ offset: 0, opacity: 0, translateX: -1 },
				{ offset: 0.12, opacity: 0, translateX: -1 },
				{ offset: 0.24, opacity: 1, translateX: -0.5 },
				{ offset: 0.42, opacity: 1, translateX: 0.5 },
				{ offset: 0.58, opacity: 0, translateX: 1 },
				{ offset: 1, opacity: 0, translateX: 1 },
			],
			duration: (Array.from(props.label).length + 5) * 60 + 2000,
			easing: easeInOut,
			iterations: "infinite",
		},
	});
	cleanup(() => motion.stop());
	return (
		<Canvas
			class="absolute inset-0 pointer-events-none"
			style={{ opacity: motion.opacity }}
			accessible={false}
			accessibilityElementsHidden
			draw={(cx, { width, height }) => {
				cx.translate(motion.translateX.mul(width / 2), 0);
				const glow = cx.createLinearGradient(width / 4, 0, (3 * width) / 4, 0);
				glow.addColorStop(0, "transparent");
				glow.addColorStop(0.5, token("primary"));
				glow.addColorStop(1, "transparent");
				cx.globalAlpha = 0.14;
				cx.fillStyle = glow;
				cx.fillRect(width / 4, 0, width / 2, height);
			}}
		/>
	);
}

/**
 * What a running reply is doing, in words (the WebUI's
 * `ChatAgentActivityIndicator`): a breathing dot and the label. With less
 * motion asked for, both stay still.
 */
export function ChatAgentActivityIndicator(props: {
	label: () => string;
	testID?: string;
}) {
	return (
		<View testID={props.testID} class="flex-row items-center gap-1.5">
			<View
				class="size-3.5 shrink-0 items-center justify-center"
				accessible={false}
				accessibilityElementsHidden
			>
				{() =>
					reduceMotion() ? (
						<View
							class="size-[34%] rounded-full bg-primary"
							style={{ opacity: 0.6, transform: [{ scale: 0.85 }] }}
						/>
					) : (
						<PulsingDot />
					)
				}
			</View>
			<View class="relative">
				{() =>
					reduceMotion() ? null : <LabelHighlight label={props.label()} />
				}
				<Text class="font-sans text-base font-medium leading-snug text-primary">
					{props.label}
				</Text>
			</View>
		</View>
	);
}
