import { lazy, Suspense, useState } from "react";
import { Monitor, Moon, Settings, Sun } from "lucide-react";

import { usePreferences } from "@/lib/preferences-provider";
import { nextCycledTheme, useTheme, type Theme } from "@/lib/theme-provider";
import { useKeyboardShortcut } from "@/lib/use-keyboard-shortcut";
import { Button, Tooltip, TooltipContent, TooltipTrigger } from "@/ui";

const SettingsDialog = lazy(() =>
	import("@/components/settings/settings-dialog").then((module) => ({
		default: module.SettingsDialog,
	})),
);

const THEME_LABELS: Record<Theme, string> = {
	light: "亮色",
	dark: "暗色",
	system: "跟随系统",
};

const THEME_ICONS: Record<Theme, typeof Sun> = {
	light: Sun,
	dark: Moon,
	system: Monitor,
};

function ThemeCycleButton() {
	const { theme, setTheme } = useTheme();
	const Icon = THEME_ICONS[theme];
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					aria-label="切换主题"
					onClick={() => setTheme(nextCycledTheme(theme))}
				>
					<Icon />
				</Button>
			</TooltipTrigger>
			<TooltipContent>主题：{THEME_LABELS[theme]}</TooltipContent>
		</Tooltip>
	);
}

export function SidebarFooter() {
	const [settingsOpen, setSettingsOpen] = useState(false);
	const { keyboardShortcuts } = usePreferences();
	useKeyboardShortcut(keyboardShortcuts["open-settings"], () => {
		setSettingsOpen(true);
	});

	return (
		<>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant="ghost"
						size="icon"
						aria-label="设置"
						onClick={() => setSettingsOpen(true)}
					>
						<Settings />
					</Button>
				</TooltipTrigger>
				<TooltipContent>设置</TooltipContent>
			</Tooltip>
			{settingsOpen ? (
				<Suspense fallback={null}>
					<SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
				</Suspense>
			) : null}
			<span className="ms-auto">
				<ThemeCycleButton />
			</span>
		</>
	);
}
