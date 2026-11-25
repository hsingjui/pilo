import {
	cleanup,
	createMotion,
	type Easing,
	reduceMotion,
	Text,
	token,
	View,
} from "nsh";

import {
	ChatReadingFont,
	createReadingIconAlignment,
	readingTextStyle,
} from "./chat-reading-font";

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

/** The WebUI's `0.08em` drift at the 16pt label size. */
const HIGHLIGHT_DRIFT = 1.3;

/**
 * A glowing copy of the label that fades in over it and drifts a hair to the
 * right (the WebUI's `.chat-agent-activity-label::after`): the glyphs light
 * up in place, no band of light sweeps across the label's box.
 */
function LabelHighlight(props: { label: string }) {
	const motion = createMotion({
		initial: { opacity: 0, translateX: -HIGHLIGHT_DRIFT },
		enter: {
			keyframes: [
				{ offset: 0, opacity: 0, translateX: -HIGHLIGHT_DRIFT },
				{ offset: 0.12, opacity: 0, translateX: -HIGHLIGHT_DRIFT },
				{ offset: 0.24, opacity: 1, translateX: 0 },
				{ offset: 0.42, opacity: 1, translateX: 0 },
				{ offset: 0.58, opacity: 0, translateX: HIGHLIGHT_DRIFT },
				{ offset: 1, opacity: 0, translateX: HIGHLIGHT_DRIFT },
			],
			duration: (Array.from(props.label).length + 5) * 60 + 2000,
			easing: easeInOut,
			iterations: "infinite",
		},
	});
	cleanup(() => motion.stop());
	const readingFont = ChatReadingFont();
	const primary = () => token("primary");
	return (
		<View
			class="absolute inset-0 pointer-events-none"
			style={motion.style}
			accessible={false}
			accessibilityElementsHidden
		>
			<Text
				class="font-sans font-medium leading-snug"
				style={{
					...readingTextStyle(readingFont()),
					color: `color-mix(in srgb, ${primary()} 96%, transparent)`,
					textShadow: [
						{
							x: 0,
							y: 0,
							blur: 11,
							color: `color-mix(in srgb, ${primary()} 20%, transparent)`,
						},
					],
				}}
			>
				{props.label}
			</Text>
		</View>
	);
}

/** The primary dot breathing beside an active label (3.5s, as the WebUI's). */
export function ChatActivityDot(props: {
	testID?: string;
	alignment: ReturnType<typeof createReadingIconAlignment>;
}) {
	return (
		<View
			testID={props.testID}
			class="size-3.5 shrink-0 items-center justify-center"
			style={props.alignment.style()}
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
	const readingFont = ChatReadingFont();
	const iconAlignment = createReadingIconAlignment();
	return (
		<View testID={props.testID} class="flex-row items-center gap-1.5">
			<ChatActivityDot alignment={iconAlignment} />
			<View class="relative">
				{() =>
					reduceMotion() ? null : <LabelHighlight label={props.label()} />
				}
				<Text
					class="font-sans font-medium leading-snug text-primary"
					style={readingTextStyle(readingFont())}
					onTextLayout={iconAlignment.onTextLayout}
				>
					{props.label}
				</Text>
			</View>
		</View>
	);
}
