import { mount, signal, Text, View } from "nsh";
import "../app/fonts";
import { Button } from "../ui/button";
import { Popover } from "../ui/popover";

mount(() => {
	const open = signal(false);
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
		</View>
	);
});
