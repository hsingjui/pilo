import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	Download,
	Monitor,
	Moon,
	RefreshCw,
	Settings,
	Smartphone,
	Sun,
	X,
} from "lucide-react";

import { getRemoteHostState, type RemoteHostState } from "@/lib/remote";
import { usePreferences } from "@/lib/preferences-provider";
import { nextCycledTheme, useTheme, type Theme } from "@/lib/theme-provider";
import { useKeyboardShortcut } from "@/lib/use-keyboard-shortcut";
import { cn } from "@/lib/utils";
import { useDesktopUpdate, type DesktopUpdate } from "@/lib/use-desktop-update";
import {
	Button,
	Card,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
	Spinner,
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
	const [state, setState] = useState<RemoteHostState | null>(null);
	const refresh = useCallback(async () => {
		try {
			const next = await getRemoteHostState();
			setState(next);
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
	return { state, running: state?.running ?? false, refresh };
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

/** 悬浮在侧边栏底栏上方的更新卡片：比挤在底栏里的小胶囊更清楚，且不挤压底栏布局。 */
function UpdateCard({
	update,
	onDismiss,
}: {
	update: DesktopUpdate;
	onDismiss: () => void;
}) {
	const { t } = useTranslation();
	const busy =
		update.status === "downloading" || update.status === "installing";
	const failed = update.status === "error";
	const progress = update.downloadProgress;

	return (
		<Card className="absolute inset-x-1.5 bottom-full z-20 mb-2 gap-3 p-3 shadow-lg">
			<output className="sr-only">
				{failed
					? t("settings.updateCardFailedTitle")
					: update.status === "installing"
						? t("settings.installing")
						: update.status === "downloading"
							? t("settings.downloading")
							: t("settings.updateCardTitle")}
			</output>
			<div className="flex items-start gap-2.5">
				<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
					{busy ? (
						<Spinner className="size-4" />
					) : (
						<Download className="size-4" />
					)}
				</span>
				<div className="min-w-0 flex-1">
					<p className="text-sm font-medium leading-snug text-foreground">
						{failed
							? t("settings.updateCardFailedTitle")
							: t("settings.updateCardTitle")}
					</p>
					<p className="mt-0.5 text-xs leading-snug text-muted-foreground">
						{failed
							? (update.error ?? t("about.updateFailed"))
							: t("settings.updateCardDescription", {
									version: update.availableVersion ?? "",
								})}
					</p>
				</div>
				<Button
					variant="ghost"
					size="icon"
					className="-mr-1 -mt-1 size-7 shrink-0 text-muted-foreground"
					aria-label={t("common.close")}
					onClick={onDismiss}
				>
					<X className="size-3.5" />
				</Button>
			</div>
			{busy && progress !== null ? (
				<div className="h-1 overflow-hidden rounded-full bg-muted">
					<div
						className="h-full rounded-full bg-primary transition-[width] duration-200"
						style={{ width: `${progress}%` }}
					/>
				</div>
			) : null}
			<Button
				size="sm"
				variant={failed ? "outline" : "default"}
				className="w-full gap-1.5"
				disabled={busy}
				onClick={() =>
					void (failed ? update.checkForUpdates() : update.installUpdate())
				}
			>
				{failed ? (
					<RefreshCw className="size-4" />
				) : busy ? (
					<Spinner className="size-4" />
				) : (
					<Download className="size-4" />
				)}
				{failed
					? t("common.retry")
					: update.status === "installing"
						? t("settings.installing")
						: update.status === "downloading"
							? progress === null
								? t("settings.downloading")
								: `${t("settings.downloading")} ${progress}%`
							: t("settings.downloadInstall")}
			</Button>
		</Card>
	);
}

export function SidebarFooter() {
	const { t } = useTranslation();
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [remoteOpen, setRemoteOpen] = useState(false);
	const update = useDesktopUpdate();
	// 用户关闭的版本；出现新版本时自然重置，无需额外 effect。
	const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
	const hasUpdate = update.availableVersion !== null;
	const updateBusy =
		update.status === "downloading" || update.status === "installing";
	const updateCardOpen =
		hasUpdate &&
		dismissedVersion !== update.availableVersion &&
		(updateBusy || update.status === "error" || update.status === "available");
	const {
		state: remoteState,
		running: remoteRunning,
		refresh: refreshRemote,
	} = useRemoteStatus(remoteOpen);
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
			{updateCardOpen && update.availableVersion !== null ? (
				<UpdateCard
					update={update}
					onDismiss={() => setDismissedVersion(update.availableVersion)}
				/>
			) : null}
			{hasUpdate && !updateCardOpen ? (
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="text-primary"
							aria-label={`${t("settings.updateAvailable")} v${update.availableVersion}`}
							onClick={() => setDismissedVersion(null)}
						>
							<Download />
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						{`${t("settings.downloadInstall")} v${update.availableVersion}`}
					</TooltipContent>
				</Tooltip>
			) : null}
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
							<RemoteSettings initialState={remoteState} />
						</DialogContent>
					</Dialog>
				</Suspense>
			) : null}
			{settingsOpen ? (
				<Suspense fallback={null}>
					<SettingsDialog
						open={settingsOpen}
						onOpenChange={setSettingsOpen}
						update={update}
					/>
				</Suspense>
			) : null}
			<span className="ms-auto flex items-center gap-1">
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
				<ThemeCycleButton />
			</span>
		</>
	);
}
