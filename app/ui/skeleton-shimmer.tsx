import {
	AnimatedValue,
	Canvas,
	cleanup,
	createMotion,
	signal,
	token,
} from "nsh";

type ShimmerClock = ReturnType<typeof createMotion>;

let sharedClock: ShimmerClock | null = null;
let activeShimmerCount = 0;

function acquireShimmerClock(): ShimmerClock {
	if (!sharedClock) {
		sharedClock = createMotion({
			enter: {
				keyframes: { translateX: [-1.3, 2.3] },
				duration: 1350,
				easing: [0.42, 0, 0.58, 1],
				iterations: "infinite",
			},
		});
	}
	activeShimmerCount += 1;
	return sharedClock;
}

function releaseShimmerClock() {
	activeShimmerCount = Math.max(0, activeShimmerCount - 1);
	if (activeShimmerCount === 0 && sharedClock) {
		sharedClock.stop();
		sharedClock = null;
	}
}

export function SkeletonShimmer() {
	const width = new AnimatedValue(0);
	const ready = signal(false);
	const motion = acquireShimmerClock();
	const offset = motion.translateX.mul(width);
	cleanup(releaseShimmerClock);
	return (
		<Canvas
			class="absolute inset-0 w-[58%] pointer-events-none"
			style={{ transform: [{ translateX: offset }], opacity: ready() ? 1 : 0 }}
			accessible={false}
			accessibilityElementsHidden
			onLayout={({ bounds }) => {
				width.set(bounds.size.width);
				ready.set(true);
			}}
			draw={(cx, size) => {
				const gradient = cx.createLinearGradient(0, 0, size.width, 0);
				gradient.addColorStop(0, "transparent");
				gradient.addColorStop(0.5, token("foreground"));
				gradient.addColorStop(1, "transparent");
				cx.globalAlpha = 0.065;
				cx.fillStyle = gradient;
				cx.fillRect(0, 0, size.width, size.height);
			}}
		/>
	);
}
