import {
	cleanup,
	mount,
	Overlay,
	setTheme,
	signal,
	Text,
	token,
	View,
} from "nsh";
import "../shell/fonts";
import claude from "../../theme/claude-theme.json";
import { Button } from "../ui/button";
import { Foreground } from "../ui/foreground";
import { Toast } from "../ui/toast";
import { ToastCloseButton } from "../ui/toast-close-button";
import { Icon } from "../ui/icon";
import { ToastManager, ToastStack } from "../ui/toast-stack";
import { setStyleTheme } from "../ui/theme-style";

const variants = ["default", "success", "info", "warning", "error"] as const;
const colors = [
	"popover-foreground",
	"status-success",
	"muted-foreground",
	"status-warning",
	"status-danger",
] as const;

function ColorProbe(props: { name: string }) {
	const color = Foreground();
	return (
		<View
			testID={`color-${props.name}`}
			class="size-4"
			style={{ backgroundColor: color() }}
		/>
	);
}

mount(() => {
	const manager = new ToastManager({
		duration: 0,
		exitDuration: 0,
		expandedGap: 12,
		collapsedVisible: 5,
	});
	const entries = signal(manager.entries());
	const expanded = signal(false);
	const theme = signal("Lody");
	const sync = () => entries.set(manager.entries());
	const dismiss = (id: string) => {
		manager.dismiss(id);
		manager.advance();
		sync();
	};
	const add = (id: string, timeout?: number) => {
		manager.push(id, id, { timeout });
		manager.advance();
		sync();
	};
	const timer = setInterval(() => {
		if (manager.advance(expanded()).changed) sync();
	}, 16);
	cleanup(() => {
		clearInterval(timer);
		manager.dispose();
	});
	return (
		<View class="flex-1 p-8 gap-4 bg-background font-sans text-foreground">
			<Text class="text-2xl font-semibold">Pilo / Native Toasts</Text>
			<Text>{() => `${theme()} theme · neutral surfaces, semantic icons`}</Text>
			<View class="flex-row gap-2">
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
				<Button testID="timed" onPress={() => add("Timed", 1000)}>
					<Text>Show timed toast</Text>
				</Button>
				<Button testID="manual" onPress={() => add("Manual")}>
					<Text>Show persistent toast</Text>
				</Button>
				<Button
					testID="stack"
					onPress={() => {
						add("First");
						add("Second");
						add("Third");
					}}
				>
					<Text>Show stack</Text>
				</Button>
			</View>
			<Text>{() => `Expanded: ${expanded()}`}</Text>
			<View class="flex-row gap-5 mt-12">
				<View class="w-96 gap-4">
					<Text class="text-lg font-semibold">Toast variants</Text>
					{variants.map((variant) => (
						<Toast
							transitionStatus="present"
							variant={variant}
							testID={`variant-${variant}`}
							description="Session changes have been saved."
						>
							<Text>{variant}</Text>
						</Toast>
					))}
				</View>
				<View class="gap-2">
					<Text class="text-lg font-semibold">Variant color probes</Text>
					{variants.map((variant, index) => (
						<View class="flex-row items-center gap-2">
							<Toast
								transitionStatus="present"
								variant={variant}
								icon={<ColorProbe name={variant} />}
								closeButton={false}
							>
								<Text>{variant}</Text>
							</Toast>
							<View
								testID={`reference-${variant}`}
								class="size-4"
								style={{ backgroundColor: token(colors[index]) }}
							/>
						</View>
					))}
					<View
						testID="surface"
						class="size-1 opacity-0"
						style={{ backgroundColor: token("popover") }}
					/>
				</View>
			</View>
			<Overlay class="top-52 right-8 w-96">
				<ToastStack
					motion={{ duration: 0, expandedGap: 12, collapsedVisible: 5 }}
					onExpandedChange={({ expanded: value }) => expanded.set(value)}
					onCancel={() => {
						const newest = entries().at(-1);
						if (newest) dismiss(newest.id);
					}}
				>
					<Each of={entries()} key={(entry) => entry.id}>
						{(entry) => (
							<Toast
								testID={`toast-${entry().id}`}
								transitionStatus={entry().status}
								variant={entry().id === "Timed" ? "info" : "success"}
								description="Native lifecycle · swipe or dismiss"
								accessibilityLabel={`${entry().id} notification`}
								closeLabel={`Dismiss ${entry().id}`}
								onDismissRequest={() => dismiss(entry().id)}
							>
								<Text>{() => `${entry().id} notification`}</Text>
							</Toast>
						)}
					</Each>
				</ToastStack>
			</Overlay>
			<View class="flex-row gap-4 items-center">
				<Text>Close icon hover</Text>
				<ToastCloseButton
					testID="close-preview"
					class="opacity-100"
					accessibilityLabel="Close preview"
				>
					<Icon name="X" size={14} />
					<View class="absolute opacity-0 pointer-events-none">
						<ColorProbe name="close" />
						<Text>Close inherited text</Text>
					</View>
				</ToastCloseButton>
				<View class="absolute opacity-0 pointer-events-none">
					<View testID="close-muted" class="size-px bg-muted-foreground" />
					<View testID="close-hover" class="size-px bg-popover-foreground" />
					<Text class="text-muted-foreground">Close resting reference</Text>
					<Text class="text-popover-foreground">Close hover reference</Text>
				</View>
			</View>
		</View>
	);
});
