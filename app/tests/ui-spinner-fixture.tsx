import { mount, setTheme, signal, Text, View, type ViewRef } from "nsh";
import claude from "../../theme/claude-theme.json";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { setStyleTheme } from "../ui/theme-style";

mount(() => {
	const measured = signal("");
	const extra = signal(false);
	const blocking = signal("JS ready");
	const refs: ViewRef[] = [];
	return (
		<View class="flex-1 p-8 gap-6 bg-background text-foreground font-sans">
			<Text class="text-2xl font-semibold">Pilo / Spinner</Text>
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
				24pt default · 14pt class · 32pt explicit · Foreground inheritance
			</Text>
			<View class="flex-row gap-6 items-center">
				<Spinner
					accessibilityLabel="Loading"
					ref={(ref) => {
						refs[0] = ref;
					}}
				/>
				<Spinner
					class="size-3.5"
					ref={(ref) => {
						refs[1] = ref;
					}}
				/>
				<Spinner
					size={32}
					color="#8750b2"
					ref={(ref) => {
						refs[2] = ref;
					}}
				/>
				<Button>
					<Spinner size={16} />
					<Text>Working</Text>
				</Button>
			</View>
			<Button testID="extra" onPress={() => extra.set(!extra())}>
				<Text>Toggle a late spinner</Text>
			</Button>
			{() =>
				extra() ? (
					<View class="flex-row gap-6">
						<Spinner />
						<Spinner />
					</View>
				) : null
			}
			<Button
				testID="measure"
				onPress={async () => {
					const frames = await Promise.all(refs.map((ref) => ref.measure()));
					measured.set(
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
			<View class="flex-row gap-4 items-center">
				<Button
					testID="block"
					onPress={() => {
						blocking.set("Blocking JS for 1500ms");
						setTimeout(() => {
							const start = Date.now();
							console.log(`SPINNER_BLOCK_START ${start}`);
							while (Date.now() - start < 1500) {}
							const end = Date.now();
							console.log(`SPINNER_BLOCK_END ${end}`);
							blocking.set(`JS resumed after ${end - start}ms`);
						}, 250);
					}}
				>
					<Text>Block JS for 1.5s</Text>
				</Button>
				<Text>{blocking}</Text>
			</View>
			<Text>{measured}</Text>
			<Text>
				Native one-second rotation. Late mounts start at their own phase.
			</Text>
			<Text>
				Negative-delay diagnostic: -500ms / 0ms (clamped to the same phase)
			</Text>
			<View class="flex-row gap-6">
				<Spinner style={{ animationDelay: -500 }} />
				<Spinner style={{ animationDelay: 0 }} />
			</View>
		</View>
	);
});
