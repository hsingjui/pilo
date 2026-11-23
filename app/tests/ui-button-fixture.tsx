import {
	Text,
	View,
	colorScheme,
	mount,
	setTheme,
	signal,
	type ViewRef,
} from "nsh";
import "../shell/fonts";
import { Button, type ButtonProps } from "../ui/button";
import { Icon } from "../ui/icon";
import { Foreground } from "../ui/foreground";
import { setStyleTheme, styleVar } from "../ui/theme-style";
import lody from "../../theme/theme.json";
import claude from "../../theme/claude-theme.json";

const variants = [
	"default",
	"secondary",
	"destructive",
	"outline",
	"ghost",
	"link",
] as const;
const sizes = ["default", "sm", "lg", "icon"] as const;
const refs: Record<string, ViewRef> = {};
const pressed = signal(0);
const measured = signal("Not measured");
const aligned = signal("Not aligned");
const theme = signal<typeof lody | typeof claude>(lody);

function ForegroundProbe(props: { variant: string }) {
	const foreground = Foreground();
	return (
		<View
			testID={`foreground-${props.variant}`}
			style={{
				position: "absolute",
				width: 1,
				height: 1,
				opacity: 0,
				backgroundColor: foreground(),
			}}
		/>
	);
}

function reference(
	name:
		| "primary"
		| "button-secondary"
		| "destructive"
		| "button-hover"
		| "button-secondary-hover"
		| "hover",
) {
	return theme().cssVars[colorScheme()][name];
}

function applyClaude() {
	setTheme({ cssVars: claude.cssVars });
	setStyleTheme(claude.styleVars);
	theme.set(claude);
}

mount(() => (
	<View class="gap-2 p-4 bg-background items-start">
		{variants.map((variant) => (
			<View class="flex-row items-center gap-2">
				{sizes.map((size) => (
					<Button
						variant={variant}
						size={size}
						testID={`${variant}-${size}`}
						accessibilityLabel={`${variant} ${size}`}
						ref={(node) => {
							refs[`${variant}-${size}`] = node;
						}}
					>
						{size === "icon" ? (
							<Icon name="Plus" />
						) : (
							<Text>
								{variant} {size}
							</Text>
						)}
						{size === "icon" ? <ForegroundProbe variant={variant} /> : null}
					</Button>
				))}
			</View>
		))}
		<View class="flex-row gap-2">
			<Button testID="press" onPress={() => pressed.update((n) => n + 1)}>
				<Icon name="Plus" />
				<Text>Press</Text>
			</Button>
			<Button
				testID="disabled"
				disabled
				onPress={() => pressed.update((n) => n + 100)}
			>
				<Text>Disabled</Text>
			</Button>
			<Button testID="empty" accessibilityLabel="Empty button" />
			<Button testID="custom" class="bg-[#123456]" style={{ opacity: 0.8 }}>
				<Text>Custom</Text>
			</Button>
		</View>
		<Text>{() => `Pressed: ${pressed()}`}</Text>
		<Button
			testID="measure"
			onPress={async () => {
				const checks = await Promise.all(
					Object.entries(refs).map(async ([id, ref]) => {
						const bounds = (await ref.measure())?.bounds.size;
						const size = id.split("-")[1] as ButtonProps["size"];
						const height = size === "sm" ? 32 : size === "lg" ? 40 : 36;
						return (
							bounds?.height === height &&
							(size !== "icon" || bounds.width === 36)
						);
					}),
				);
				measured.set(
					checks.every(Boolean)
						? "All 24 button sizes match"
						: "Incorrect button size",
				);
				const centers = await Promise.all(
					variants.map(async (variant) => {
						const frames = await Promise.all(
							sizes.map((size) => refs[`${variant}-${size}`].measure()),
						);
						const positions = frames.map((frame) =>
							frame ? frame.pagePosition.y + frame.bounds.size.height / 2 : NaN,
						);
						return positions.every((position) => position === positions[0]);
					}),
				);
				aligned.set(
					centers.every(Boolean)
						? "All row centers align"
						: "Incorrect row alignment",
				);
			}}
		>
			<Text>Measure buttons</Text>
		</Button>
		<Text>{measured}</Text>
		<Text>{aligned}</Text>
		<Button testID="claude" onPress={applyClaude}>
			<Text>Apply Claude</Text>
		</Button>
		<Button
			testID="restore"
			onPress={() => {
				setTheme(null);
				setStyleTheme(null);
				theme.set(lody);
			}}
		>
			<Text>Restore Lody</Text>
		</Button>
		<View
			class="absolute flex-row opacity-0 pointer-events-none"
			accessibilityElementsHidden
		>
			{(
				[
					"primary",
					"button-secondary",
					"destructive",
					"button-hover",
					"button-secondary-hover",
					"hover",
				] as const
			).map((name) => (
				<View
					testID={`reference-${name}`}
					style={{ width: 2, height: 2, backgroundColor: reference(name) }}
				/>
			))}
		</View>
		<View
			class="absolute flex-row opacity-0 pointer-events-none"
			accessibilityElementsHidden
		>
			{(
				[
					"primary-foreground",
					"button-secondary-foreground",
					"destructive-foreground",
					"foreground",
				] as const
			).map((name) => (
				<View
					testID={`reference-${name}`}
					style={{
						width: 1,
						height: 1,
						backgroundColor: theme().cssVars[colorScheme()][name],
					}}
				/>
			))}
		</View>
		<Text>{() => `Shadow: ${styleVar("pilo-button-primary-shadow")}`}</Text>
	</View>
));
