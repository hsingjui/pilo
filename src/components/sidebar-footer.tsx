import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Monitor, Moon, Settings, Smartphone, Sun } from "lucide-react";

import { getRemoteHostState } from "@/lib/remote";
import { usePreferences } from "@/lib/preferences-provider";
import { nextCycledTheme, useTheme, type Theme } from "@/lib/theme-provider";
import { useKeyboardShortcut } from "@/lib/use-keyboard-shortcut";
import { cn } from "@/lib/utils";
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/ui";

const SettingsDialog = lazy(() =>
	import("@/components/settings/settings-dialog").then((module) => ({
		default: module.SettingsDialog,
	})),
);

const RemoteSettings = lazy(() =>
	import("@/components/settings/remote-settings").then((module) => ({
		default: module.RemoteSettings,
	})),
);

/** 轮询 Remote WebUI 运行状态驱动侧边栏手机按钮高亮(无后端推送事件)。弹窗打开时暂停轮询,交由 RemoteSettings 刷新,避免重复请求。 */
function useRemoteStatus(paused: boolean) {
	const [running, setRunning] = useState(false);
	const refresh = useCallback(async () => {
		try {
			const state = await getRemoteHostState();
			setRunning(state.running);
		} catch {
			// 命令不可用时保持当前显示，等待下一轮轮询
		}
	}, []);
	/* oxlint-disable react/set-state-in-effect -- 该按钮高亮镜像外部 Rust Remote Host 的运行状态，与 RemoteSettings 轮询同一外部系统。 */
	useEffect(() => {
		void refresh();
		if (paused) return;
		const timer = window.setInterval(() => void refresh(), 3_000);
		return () => window.clearInterval(timer);
	}, [refresh, paused]);
	/* oxlint-enable react/set-state-in-effect */
	return { running, refresh };
}

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
	const [remoteOpen, setRemoteOpen] = useState(false);
	const { running: remoteRunning, refresh: refreshRemote } =
		useRemoteStatus(remoteOpen);
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
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant="ghost"
						size="icon"
						aria-label={t("settings.remote")}
						onClick={() => setRemoteOpen(true)}
					>
						<Smartphone
							className={cn(
								"transition-colors",
								remoteRunning && "text-primary",
							)}
						/>
					</Button>
				</TooltipTrigger>
				<TooltipContent>{t("settings.remote")}</TooltipContent>
			</Tooltip>
			{remoteOpen ? (
				<Suspense fallback={null}>
					<Dialog
						open
						onOpenChange={(next) => {
							setRemoteOpen(next);
							// 弹窗内开关后立即同步按钮高亮，不等下一轮轮询
							if (!next) void refreshRemote();
						}}
					>
						<DialogContent className="w-[calc(100vw-4rem)] max-w-[680px] gap-3 overflow-y-auto">
							<DialogTitle>{t("settings.remote")}</DialogTitle>
							<DialogDescription className="sr-only">
								{t("settings.remoteDescription")}
							</DialogDescription>
							<RemoteSettings />
						</DialogContent>
					</Dialog>
				</Suspense>
			) : null}
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
