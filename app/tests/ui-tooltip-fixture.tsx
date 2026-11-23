import { colorScheme, mount, setTheme, signal, token, Text, View } from "nsh";
import "../shell/fonts";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";
import { setStyleTheme } from "../ui/theme-style";
import claude from "../../theme/claude-theme.json";

mount(() => {
	const open = signal(false);
	const isClaude = signal(false);
	return (
		<View class="p-12 gap-6 items-start bg-background">
			<Button
				testID="trigger"
				tooltip={
					<Tooltip testID="bubble" placement="right" delay={0}>
						<Text>Helpful hint</Text>
					</Tooltip>
				}
			>
				<Text>Hover for a hint</Text>
			</Button>
			<Button
				testID="controlled"
				tooltip={
					<Tooltip
						placement="bottom"
						delay={0}
						open={open()}
						onOpenChange={({ open: next }) => open.set(next)}
					>
						<Text>Controlled hint</Text>
					</Tooltip>
				}
			>
				<Text>Controlled</Text>
			</Button>
			<View testID="leave" class="w-40 h-12">
				<Text>Move pointer here</Text>
			</View>
			<Button
				testID="disabled-trigger"
				tooltip={
					<Tooltip disabled delay={0}>
						<Text>Disabled hint</Text>
					</Tooltip>
				}
			>
				<Text>No tooltip</Text>
			</Button>
			<Text>{() => `Open: ${open()}`}</Text>
			<Button
				testID="claude"
				onPress={() => {
					setTheme({ cssVars: claude.cssVars });
					setStyleTheme(claude.styleVars);
					isClaude.set(true);
				}}
			>
				<Text>Apply Claude</Text>
			</Button>
			<View
				testID="reference-background"
				style={{
					width: 1,
					height: 1,
					opacity: 0,
					backgroundColor: isClaude()
						? claude.cssVars[colorScheme()]["tooltip-background"]
						: token("popover"),
				}}
			/>
		</View>
	);
});
