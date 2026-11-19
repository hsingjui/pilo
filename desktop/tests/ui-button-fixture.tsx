import {
	Text,
	View,
	colorScheme,
	mount,
	setTheme,
	signal,
	token,
	type ViewRef,
} from "nsh";
import "../app/fonts";
import { Button, type ButtonProps } from "../ui/button";
import { Icon } from "../ui/icon";
import { setStyleTheme, styleVar } from "../ui/theme-style";
import lody from "../theme.json";
import claude from "../claude-theme.json";

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
const theme = signal<typeof lody | typeof claude>(lody);

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
			<View class="flex-row gap-2">
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
							<Icon
								name="Plus"
								color={token(
									variant === "default" ? "primary-foreground" : "foreground",
								)}
							/>
						) : (
							<Text>
								{variant} {size}
							</Text>
						)}
					</Button>
				))}
			</View>
		))}
		<View class="flex-row gap-2">
			<Button testID="press" onPress={() => pressed.update((n) => n + 1)}>
				<Icon name="Plus" color={token("primary-foreground")} />
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
			}}
		>
			<Text>Measure buttons</Text>
		</Button>
		<Text>{measured}</Text>
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
		<View class="flex-row">
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
		<Text>{() => `Shadow: ${styleVar("pilo-button-primary-shadow")}`}</Text>
	</View>
));
