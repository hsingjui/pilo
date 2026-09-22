import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
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

const THEME_LABEL_KEYS: Record<
	Theme,
	"settings.light" | "settings.dark" | "settings.system"
> = {
	light: "settings.light",
	dark: "settings.dark",
	system: "settings.system",
};

const THEME_ICONS: Record<Theme, typeof Sun> = {
	light: Sun,
	dark: Moon,
	system: Monitor,
};

function ThemeCycleButton() {
	const { t } = useTranslation();
	const { theme, setTheme } = useTheme();
	const Icon = THEME_ICONS[theme];
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					aria-label={t("settings.theme")}
					onClick={() => setTheme(nextCycledTheme(theme))}
				>
					<Icon />
				</Button>
			</TooltipTrigger>
			<TooltipContent>
				{t("settings.theme")}: {t(THEME_LABEL_KEYS[theme])}
			</TooltipContent>
		</Tooltip>
	);
}

export function SidebarFooter() {
	const { t } = useTranslation();
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
						aria-label={t("settings.title")}
						onClick={() => setSettingsOpen(true)}
					>
						<Settings />
					</Button>
				</TooltipTrigger>
				<TooltipContent>{t("settings.title")}</TooltipContent>
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
