import {
	computed,
	List,
	mount,
	reduceMotion,
	setColorScheme,
	signal,
	Text,
	token,
	View,
	windowSize,
} from "nsh";
import { Collapsible } from "nsh/base";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { CopyStatusIcon } from "../ui/copy-status-icon";
import { Dialog } from "../ui/dialog";
import { DialogClose } from "../ui/dialog-close";
import { DialogHeader } from "../ui/dialog-header";
import { DialogTitle } from "../ui/dialog-title";
import { Input } from "../ui/input";
import { Menu } from "../ui/menu";
import { MenuItem } from "../ui/menu-item";
import {
	chevronRotateStyle,
	collapsibleRevealProps,
	MOTION,
	tactileTransition,
	useMountedDialog,
} from "../ui/motion";
import { Popover } from "../ui/popover";
import { scrollbarLook, scrollbarTheme } from "../ui/scrollbar";
import { Select } from "../ui/select";
import { Switch } from "../ui/switch";
import { Tab } from "../ui/tab";
import { Tabs } from "../ui/tabs";
import { Icon } from "../ui/icon";

const LONG_ROWS = Array.from({ length: 200 }, (_, i) => ({
	id: `row-${i}`,
	title: `Conversation turn #${i + 1}`,
	detail: `Tool call result & streamed summary payload for item ${i + 1}`,
}));

mount(() => {
	const tab = signal<"overview" | "activity" | "files">("overview");
	const switched = signal(false);
	const checked = signal(false);
	const copied = signal(false);
	const expanded = signal(false);
	const dialogOpen = signal(false);
	const dialog = useMountedDialog(dialogOpen);
	const scheme = signal<"light" | "dark">("light");
	const selectValue = signal<string | null>("lody");
	const benchResult = signal("bench:pending");
	const viewportLabel = computed(
		() =>
			`${Math.round(windowSize().width)}x${Math.round(windowSize().height)}`,
	);

	const runBurstBenchmark = () => {
		const samples: number[] = [];
		for (let i = 0; i < 40; i++) {
			const start = performance.now();
			tab.set(i % 3 === 0 ? "overview" : i % 3 === 1 ? "activity" : "files");
			switched.update((v) => !v);
			checked.update((v) => !v);
			expanded.update((v) => !v);
			copied.update((v) => !v);
			samples.push(performance.now() - start);
		}
		samples.sort((a, b) => a - b);
		const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
		const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
		const max = samples.at(-1) ?? 0;
		benchResult.set(
			`bench:ok avg=${avg.toFixed(2)}ms p95=${p95.toFixed(2)}ms max=${max.toFixed(2)}ms reduceMotion=${reduceMotion()}`,
		);
	};

	return (
		<View class="flex-1 bg-background p-4 gap-3 font-sans text-foreground">
			<View class="flex-row flex-wrap items-center gap-2">
				<Tabs
					orientation="horizontal"
					accessibilityLabel="Motion sections"
					testID="motion-tabs"
				>
					{(["overview", "activity", "files"] as const).map((id) => (
						<Tab
							testID={`motion-tab-${id}`}
							selected={tab() === id}
							onPress={() => tab.set(id)}
						>
							<Text>{id}</Text>
						</Tab>
					))}
				</Tabs>
				<Switch
					testID="motion-switch"
					accessibilityLabel="Toggle switch"
					checked={switched()}
					onChange={({ checked: next }) => switched.set(next)}
				/>
				<Checkbox
					testID="motion-checkbox"
					accessibilityLabel="Toggle checkbox"
					checked={checked()}
					onChange={({ checked: next }) => checked.set(next)}
				/>
				<Button
					testID="motion-copy"
					variant="outline"
					size="sm"
					onPress={() => copied.update((v) => !v)}
				>
					<CopyStatusIcon copied={copied} size={14} />
					<Text>{() => (copied() ? "Copied" : "Copy")}</Text>
				</Button>
				<Button
					testID="motion-open-dialog"
					variant="secondary"
					size="sm"
					onPress={() => dialogOpen.set(true)}
				>
					<Text>Open Dialog</Text>
				</Button>
				<Button
					testID="motion-toggle-scheme"
					variant="ghost"
					size="sm"
					onPress={() => {
						const next = scheme() === "light" ? "dark" : "light";
						scheme.set(next);
						setColorScheme(next);
					}}
				>
					<Text>{() => `Scheme: ${scheme()}`}</Text>
				</Button>
				<Button
					testID="motion-bench"
					variant="default"
					size="sm"
					onPress={runBurstBenchmark}
				>
					<Text>Run Burst Benchmark</Text>
				</Button>
			</View>

			<View class="flex-row flex-wrap items-center gap-2">
				<Input
					testID="motion-input"
					size="sm"
					class="w-40"
					placeholder="Focus transition"
				/>
				<Select
					testID="motion-select"
					size="sm"
					class="w-36"
					value={selectValue()}
					onChange={({ value }) => selectValue.set(value)}
					items={[
						{ value: "lody", title: "Lody" },
						{ value: "claude", title: "Claude" },
						{ value: "ocean", title: "Ocean" },
					]}
				/>
				<Popover
					trigger={
						<Button testID="motion-popover-trigger" variant="outline" size="sm">
							<Text>Popover</Text>
						</Button>
					}
				>
					<Text testID="motion-popover-body">Anchored popover surface</Text>
				</Popover>
				<Menu
					trigger={
						<Button testID="motion-menu-trigger" variant="outline" size="sm">
							<Text>Menu</Text>
						</Button>
					}
				>
					<MenuItem>
						<Text>Item A</Text>
					</MenuItem>
					<MenuItem>
						<Text>Item B</Text>
					</MenuItem>
				</Menu>
			</View>

			<View class="rounded-lg border border-border bg-card p-2">
				<View
					testID="motion-collapsible-trigger"
					role="button"
					class="flex-row items-center gap-2 rounded-md px-2 py-1 hover:bg-hover"
					style={tactileTransition("background-color")}
					onPress={() => expanded.update((v) => !v)}
				>
					<View style={chevronRotateStyle(expanded(), 0, 90)}>
						<Icon
							name="ChevronRight"
							size={14}
							color={token("muted-foreground")}
						/>
					</View>
					<Text class="text-sm font-medium">
						{() => (expanded() ? "Expanded details" : "Collapsed details")}
					</Text>
				</View>
				<Collapsible
					open={expanded()}
					{...collapsibleRevealProps(MOTION.spring.smooth)}
					content={
						<View testID="motion-collapsible-body" class="px-2 pt-2 pb-1">
							<Text class="text-xs text-muted-foreground">
								Spring reveal content driven natively on the UI thread.
							</Text>
						</View>
					}
				/>
			</View>

			<View class="flex-col gap-1">
				<Text
					testID="motion-bench-result"
					class="font-mono text-xs text-muted-foreground"
				>
					{benchResult}
				</Text>
				<Text
					testID="motion-meta"
					class="font-mono text-xs text-muted-foreground"
				>
					{() =>
						`vp:${viewportLabel()} scheme:${scheme()} dialogMounted:${dialog.mounted()}`
					}
				</Text>
			</View>

			<List
				testID="motion-long-list"
				class="min-h-0 flex-1 rounded-lg border border-border"
				each={LONG_ROWS}
				keyExtractor={(item) => item.id}
				estimatedItemSize={48}
				scrollbar={scrollbarTheme({ vertical: scrollbarLook() })}
			>
				{(item) => (
					<View class="border-b border-border/50 px-3 py-2">
						<Text class="text-xs font-medium text-foreground">
							{() => item().title}
						</Text>
						<Text class="text-xs text-muted-foreground">
							{() => item().detail}
						</Text>
					</View>
				)}
			</List>

			<Dialog
				testID="motion-dialog"
				open={dialogOpen()}
				accessibilityLabel="Motion dialog"
				onOpenChange={({ open }) => {
					if (!open) dialogOpen.set(false);
				}}
				onClose={dialog.onClose}
			>
				{() =>
					dialog.mounted() ? (
						<View>
							<DialogHeader>
								<DialogTitle>Motion Dialog Title</DialogTitle>
							</DialogHeader>
							<Text
								testID="motion-dialog-content"
								class="text-sm text-muted-foreground"
							>
								Content stays mounted during close fade.
							</Text>
							<DialogClose
								testID="motion-dialog-close"
								accessibilityLabel="Close dialog"
								onPress={() => dialogOpen.set(false)}
							/>
						</View>
					) : null
				}
			</Dialog>
		</View>
	);
});
