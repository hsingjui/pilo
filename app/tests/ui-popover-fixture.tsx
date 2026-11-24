import { mount, signal, Text, View, type ViewRef } from "nsh";
import { Button } from "../ui/button";
import { Popover } from "../ui/popover";

mount(() => {
	const open = signal(false);
	const positioned = signal(false);
	const align = signal<"start" | undefined>(undefined);
	const geometry = signal("Not positioned");
	let anchor: ViewRef | undefined;
	return (
		<View class="p-12 gap-12 items-start bg-background">
			<Popover
				placement="right"
				open={open()}
				onOpenChange={({ open: next }) => open.set(next)}
				trigger={
					<Button testID="trigger">
						<Text>Open popover</Text>
					</Button>
				}
			>
				<Text>Popover content</Text>
			</Popover>
			<Button testID="outside">
				<Text>Outside</Text>
			</Button>
			<Text>{() => `Open: ${open()}`}</Text>
			<Popover
				trigger={
					<Button testID="uncontrolled">
						<Text>Uncontrolled</Text>
					</Button>
				}
			>
				<Text>Uncontrolled content</Text>
			</Popover>
			<View class="ml-64 gap-3 items-start">
				<Popover
					open={positioned()}
					align={align()}
					popupClass="w-64"
					onOpenChange={({ open }) => positioned.set(open)}
					onPosition={async ({ bounds }) => {
						const trigger = await anchor?.measure();
						if (trigger)
							geometry.set(
								`Left delta: ${(bounds.origin.x - trigger.pagePosition.x).toFixed(0)}; Center delta: ${(bounds.origin.x + bounds.size.width / 2 - trigger.pagePosition.x - trigger.bounds.size.width / 2).toFixed(0)}`,
							);
					}}
					trigger={
						<Button
							testID="position-trigger"
							class="w-32"
							ref={(view) => {
								anchor = view;
							}}
						>
							<Text>Alignment</Text>
						</Button>
					}
				>
					<Text>Positioned popup</Text>
				</Popover>
				<Button
					testID="position-start"
					onPress={() => {
						align.set("start");
						positioned.set(true);
					}}
				>
					<Text>Start aligned popup</Text>
				</Button>
			</View>
			<Text>{() => geometry()}</Text>
		</View>
	);
});
