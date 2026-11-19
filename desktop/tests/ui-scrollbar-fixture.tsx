import {
	mount,
	Scroll,
	setTheme,
	signal,
	Text,
	View,
	type ScrollRef,
	type ViewRef,
} from "nsh";
import claude from "../claude-theme.json";
import "../app/fonts";
import { Button } from "../ui/button";
import { Scrollbar, scrollbarLook } from "../ui/scrollbar";
import { setStyleTheme } from "../ui/theme-style";

function Fixture() {
	let vertical: ScrollRef | undefined;
	let horizontal: ScrollRef | undefined;
	let verticalBar: ViewRef | undefined;
	let horizontalBar: ViewRef | undefined;
	let fit: ScrollRef | undefined;
	let hover: ScrollRef | undefined;
	const y = signal(0);
	const x = signal(0);
	const height = signal(1200);
	const theme = signal("Lody");
	const geometry = signal("");
	return (
		<View class="flex-1 bg-background p-8 gap-6 text-foreground font-sans">
			<Text class="text-2xl font-semibold">Pilo / Native Scrollbars</Text>
			<Text>
				{() =>
					`${theme()} theme · transparent tracks, rounded token-colored thumbs`
				}
			</Text>
			<View class="flex-row gap-3">
				<Button
					testID="claude"
					onPress={() => {
						setTheme({ cssVars: claude.cssVars });
						setStyleTheme(claude.styleVars);
						theme.set("Claude");
					}}
				>
					<Text>Claude</Text>
				</Button>
				<Button
					testID="center"
					onPress={() => {
						vertical?.scrollTo({ y: 480, animated: false });
						horizontal?.scrollTo({ x: 480, animated: false });
					}}
				>
					<Text>Center thumbs</Text>
				</Button>
				<Button testID="shrink" onPress={() => height.set(80)}>
					<Text>Fit content</Text>
				</Button>
				<Button testID="grow" onPress={() => height.set(1200)}>
					<Text>Overflow content</Text>
				</Button>
				<Button
					testID="measure"
					onPress={async () => {
						const v = await verticalBar?.measure();
						const h = await horizontalBar?.measure();
						geometry.set(
							`${v?.bounds.size.width} × ${v?.bounds.size.height}; ${h?.bounds.size.width} × ${h?.bounds.size.height}`,
						);
					}}
				>
					<Text>Measure tracks</Text>
				</Button>
			</View>
			<View class="flex-row items-start gap-8">
				<View class="gap-3">
					<Text class="font-semibold">Vertical · overflow</Text>
					<View class="relative w-80 h-60 rounded-lg border border-border">
						<Scroll
							testID="vertical"
							ref={(ref) => {
								vertical = ref;
							}}
							scrollbar={false}
							class="size-full"
							onScroll={(e) => y.set(Math.round(e.offset.y))}
						>
							<View style={{ height: height() }} class="shrink-0 p-4 gap-8">
								{() =>
									Array.from({ length: height() > 80 ? 20 : 1 }, (_, i) => (
										<Text>{`Row ${i + 1}`}</Text>
									))
								}
							</View>
						</Scroll>
						<Scrollbar
							testID="vertical-bar"
							accessibilityLabel="Vertical scrollbar"
							ref={(ref) => {
								verticalBar = ref;
							}}
							scroll={vertical}
							mode="always"
						/>
					</View>
					<Text>{() => `Vertical offset: ${y()}`}</Text>
				</View>
				<View class="gap-3">
					<Text class="font-semibold">Horizontal · overflow</Text>
					<View class="relative w-80 h-32 rounded-lg border border-border">
						<Scroll
							testID="horizontal"
							ref={(ref) => {
								horizontal = ref;
							}}
							horizontal
							scrollbar={false}
							class="size-full"
							onScroll={(e) => x.set(Math.round(e.offset.x))}
						>
							<View class="w-[1280px] h-full shrink-0 flex-row items-center justify-between px-4">
								{Array.from({ length: 8 }, (_, i) => (
									<Text>{`Column ${i + 1}`}</Text>
								))}
							</View>
						</Scroll>
						<Scrollbar
							testID="horizontal-bar"
							ref={(ref) => {
								horizontalBar = ref;
							}}
							scroll={horizontal}
							axis="horizontal"
							mode="always"
						/>
					</View>
					<Text>{() => `Horizontal offset: ${x()}`}</Text>
				</View>
				<View class="gap-3">
					<Text class="font-semibold">No overflow · no thumb</Text>
					<View class="relative w-60 h-32 rounded-lg border border-border">
						<Scroll
							testID="fits"
							ref={(ref) => {
								fit = ref;
							}}
							scrollbar={false}
							class="size-full"
						>
							<Text class="p-4">Short content</Text>
						</Scroll>
						<Scrollbar testID="fit-bar" scroll={fit} mode="always" />
					</View>
					<Text class="font-semibold">Default · reveal on hover</Text>
					<View class="relative w-60 h-32 rounded-lg border border-border">
						<Scroll
							ref={(ref) => {
								hover = ref;
							}}
							scrollbar={false}
							class="size-full"
						>
							<View class="h-[800px] shrink-0 p-4">
								<Text>Hover the right edge</Text>
							</View>
						</Scroll>
						<Scrollbar
							testID="hover-bar"
							scroll={hover}
							motion={{ idle: 100, enter: 0, exit: 0 }}
						/>
					</View>
				</View>
			</View>
			<Text>{() => `Track sizes: ${geometry()}`}</Text>
			<Text class="font-semibold">
				Shared native thumb look · hover the sample
			</Text>
			<View class="flex-row gap-4 items-center">
				<View
					testID="thumb-color"
					class={scrollbarLook().thumbClass + " w-32 h-3"}
				/>
				<View testID="reference" class="w-8 h-3 bg-scrollbar-thumb/50" />
				<View
					testID="hover-reference"
					class="w-8 h-3 bg-scrollbar-thumb-hover/65"
				/>
			</View>
		</View>
	);
}

mount(Fixture);
