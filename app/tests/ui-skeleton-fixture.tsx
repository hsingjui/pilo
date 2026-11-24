import {
	mount,
	reduceMotion,
	setTheme,
	signal,
	Text,
	View,
	type ViewRef,
} from "nsh";
import claude from "../../theme/claude-theme.json";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { setStyleTheme } from "../ui/theme-style";

mount(() => {
	const result = signal("");
	const blocking = signal("JS ready");
	const refs: ViewRef[] = [];
	return (
		<View class="flex-1 p-8 gap-6 bg-background text-foreground font-sans">
			<Text class="text-2xl font-semibold">Pilo / Skeleton</Text>
			<Button
				testID="claude"
				onPress={() => {
					setTheme({ cssVars: claude.cssVars });
					setStyleTheme(claude.styleVars);
				}}
			>
				<Text>Claude</Text>
			</Button>
			<Text>
				{() =>
					reduceMotion()
						? "Reduced motion: static bones"
						: "Per-bone native shimmer · 1.35s"
				}
			</Text>
			<View class="flex-row gap-4 items-center">
				<Skeleton class="size-12 rounded-full" />
				<View class="gap-3">
					<Skeleton testID="strong" strong class="w-48 h-4" />
					<Skeleton
						testID="line"
						class="w-72 h-3"
						ref={(ref) => {
							refs[0] = ref;
						}}
					/>
				</View>
			</View>
			<Skeleton class="w-full h-28" />
			<Skeleton
				testID="empty"
				ref={(ref) => {
					refs[1] = ref;
				}}
			/>
			<View class="absolute opacity-0 pointer-events-none">
				<View testID="line-reference" class="size-px bg-skeleton-line" />
				<View
					testID="strong-reference"
					class="size-px bg-skeleton-line-strong"
				/>
			</View>
			<View class="flex-row gap-4">
				<Button
					testID="measure"
					class="flex-1"
					onPress={async () => {
						const frames = await Promise.all(refs.map((ref) => ref.measure()));
						result.set(
							frames
								.map(
									(frame) =>
										`${frame?.bounds.size.width}x${frame?.bounds.size.height}`,
								)
								.join(", "),
						);
					}}
				>
					<Text>Measure</Text>
				</Button>
				<Button
					testID="block"
					class="flex-1"
					onPress={() => {
						blocking.set("Blocking JS for 1500ms");
						setTimeout(() => {
							const start = Date.now();
							console.log(`SKELETON_BLOCK_START ${start}`);
							while (Date.now() - start < 1500) {}
							const end = Date.now();
							console.log(`SKELETON_BLOCK_END ${end}`);
							blocking.set(`JS resumed after ${end - start}ms`);
						}, 250);
					}}
				>
					<Text>Block JS for 1.5s</Text>
				</Button>
			</View>
			<Text>{() => result() || blocking()}</Text>
			<Text>Decorative only; loading announcements belong to the caller.</Text>
		</View>
	);
});
