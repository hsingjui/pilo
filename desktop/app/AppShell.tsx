import { Text, View } from "nsh";

export function AppShell() {
	return (
		<View
			testID="app"
			class="flex-1 flex-row bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
		>
			<View
				testID="sidebar"
				class="w-28 shrink-0 gap-2 border-r border-sidebar-border bg-sidebar-background p-4 sm:w-64"
			>
				<Text class="font-sans text-sm font-semibold text-sidebar-foreground">
					Pilo
				</Text>
			</View>
			<View testID="workspace" class="min-w-0 flex-1 justify-center gap-2 p-6">
				<Text class="font-sans text-xl font-semibold text-foreground">
					Workspace
				</Text>
				<Text class="font-mono text-xs text-muted-foreground">
					pilo-desktop
				</Text>
			</View>
		</View>
	);
}
