import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { appLogDir } from "@tauri-apps/api/path";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import {
	CheckCircle2,
	Code2,
	Download,
	ExternalLink,
	FolderOpen,
	RefreshCw,
} from "lucide-react";

import appIconUrl from "../../../src-tauri/icons/128x128.png";
import { cn } from "@/lib/utils";
import type { DesktopUpdate } from "@/lib/use-desktop-update";
import { Button } from "@/ui";
import {
	SETTINGS_CONTAINER_CLASS,
	SETTINGS_TEXT_BUTTON_CLASS,
	SettingsRow,
	SettingsSection,
	SettingsStatus,
} from "./compact-layout";

const REPOSITORY_URL = "https://github.com/hsingjui/pilo";
const RELEASES_URL = `${REPOSITORY_URL}/releases`;

async function handleOpenLogDirectory() {
	try {
		await openPath(await appLogDir());
	} catch (error) {
		console.error("Failed to open log directory", error);
	}
}

export function AboutSettings({ update }: { update: DesktopUpdate }) {
	const { t } = useTranslation();
	const [version, setVersion] = useState<string | null>(null);
	const {
		status: updateStatus,
		availableVersion,
		error: updateError,
		downloadProgress,
		checkForUpdates,
		installUpdate,
		previewUpdate,
	} = update;

	useEffect(() => {
		let active = true;
		void getVersion()
			.then((nextVersion) => {
				if (active) setVersion(nextVersion);
			})
			.catch(() => {
				if (active) setVersion(null);
			});
		return () => {
			active = false;
		};
	}, []);

	return (
		<div className={SETTINGS_CONTAINER_CLASS}>
			<SettingsSection contentClassName="px-4 py-4 sm:px-5 sm:py-5">
				<div className="flex items-center gap-4">
					<div className="size-16 shrink-0 overflow-hidden rounded-2xl border border-border/60 bg-background shadow-sm">
						<img
							src={appIconUrl}
							alt="Pilo"
							className="size-full object-cover"
						/>
					</div>
					<div className="min-w-0">
						<div className="flex flex-wrap items-center gap-2">
							<h3 className="text-lg font-semibold tracking-tight text-foreground">
								Pilo
							</h3>
							{version ? <SettingsStatus>v{version}</SettingsStatus> : null}
						</div>
						<p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
							{t("about.description")}
						</p>
					</div>
				</div>
			</SettingsSection>

			<SettingsSection title={t("settings.application")}>
				<SettingsRow label={t("settings.version")}>
					<span className="font-mono text-xs text-muted-foreground">
						{version ?? "—"}
					</span>
				</SettingsRow>
				<SettingsRow label={t("settings.repository")}>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className={cn(
							SETTINGS_TEXT_BUTTON_CLASS,
							"text-muted-foreground hover:text-foreground",
						)}
						onClick={() => void openUrl(REPOSITORY_URL)}
					>
						<Code2 className="size-3.5" />
						GitHub
						<ExternalLink className="size-3.5 opacity-60" />
					</Button>
				</SettingsRow>
				<SettingsRow label={t("settings.logDirectory")}>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className={cn(
							SETTINGS_TEXT_BUTTON_CLASS,
							"text-muted-foreground hover:text-foreground",
						)}
						onClick={() => void handleOpenLogDirectory()}
					>
						<FolderOpen className="size-3.5" />
						{t("settings.openLogDirectory")}
					</Button>
				</SettingsRow>
			</SettingsSection>

			<SettingsSection title={t("settings.update")}>
				<SettingsRow
					label={t("settings.updateCheck")}
					helper={updateStatus === "error" ? updateError : undefined}
				>
					<div className="flex flex-wrap items-center gap-1.5">
						{updateStatus === "latest" ? (
							<SettingsStatus>
								<CheckCircle2 className="mr-1 size-3" />
								{t("settings.latest")}
							</SettingsStatus>
						) : null}
						{updateStatus === "available" && availableVersion ? (
							<SettingsStatus>v{availableVersion}</SettingsStatus>
						) : null}
						{updateStatus === "available" ? (
							<Button
								type="button"
								variant="default"
								size="sm"
								className={SETTINGS_TEXT_BUTTON_CLASS}
								onClick={() => void installUpdate()}
							>
								<Download className="size-3.5" />
								{t("settings.downloadInstall")}
							</Button>
						) : (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className={cn(
									SETTINGS_TEXT_BUTTON_CLASS,
									"leading-none text-muted-foreground hover:text-foreground",
								)}
								disabled={
									updateStatus === "checking" ||
									updateStatus === "downloading" ||
									updateStatus === "installing"
								}
								onClick={() => void checkForUpdates()}
							>
								<RefreshCw
									className={cn(
										"size-3.5",
										updateStatus === "checking" && "animate-spin",
									)}
								/>
								{updateStatus === "checking"
									? t("settings.checking")
									: updateStatus === "downloading"
										? downloadProgress === null
											? t("settings.downloading")
											: `${t("settings.downloading")} ${downloadProgress}%`
										: updateStatus === "installing"
											? t("settings.installing")
											: t("settings.updateCheck")}
							</Button>
						)}
						{import.meta.env.DEV ? (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={previewUpdate}
							>
								{t("settings.updatePreview")}
							</Button>
						) : null}
					</div>
				</SettingsRow>
				<SettingsRow label={t("settings.releaseNotes")}>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className={cn(
							SETTINGS_TEXT_BUTTON_CLASS,
							"text-muted-foreground hover:text-foreground",
						)}
						onClick={() => void openUrl(RELEASES_URL)}
					>
						GitHub Releases
						<ExternalLink className="size-3.5 opacity-60" />
					</Button>
				</SettingsRow>
			</SettingsSection>
		</div>
	);
}
