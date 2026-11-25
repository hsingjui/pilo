import { appInfo, cleanup, Image, openUrl, Text, View } from "nsh";

import appIcon from "../assets/app-icon.png";
import {
	createDesktopUpdate,
	type DesktopUpdate,
	RELEASES_URL,
	REPOSITORY_URL,
} from "../shell/desktop-update";
import { t } from "../shell/i18n";
import { UpdateDialog } from "../shell/update-dialog";
import { Icon } from "../ui/icon";
import { Spinner } from "../ui/spinner";
import {
	SettingsActionButton,
	SettingsRow,
	SettingsSection,
	SettingsStatus,
} from "./layout";
import type { SettingsClient } from "./settings-dialog";

/**
 * Application version and updater.
 * When `update` is passed from `AppShell`, state is shared with the sidebar
 * update button and top-level `UpdateDialog`; otherwise a local controller
 * backs standalone mounts.
 */
export function AboutPane(props: {
	client: SettingsClient;
	update?: DesktopUpdate;
}) {
	const { version } = appInfo();
	const ownedUpdate = props.update
		? null
		: createDesktopUpdate({ autoCheck: false });
	if (ownedUpdate) cleanup(() => ownedUpdate.dispose());
	const update = props.update ?? ownedUpdate!;

	const status = () => update.status();
	const progress = () => update.downloadProgress();

	const buttonLabel = () => {
		switch (status()) {
			case "checking":
				return t("settings.checking");
			case "downloading": {
				const pct = progress();
				return pct === null
					? t("settings.downloading")
					: `${t("settings.downloading")} ${pct}%`;
			}
			case "installing":
				return t("settings.installing");
			default:
				return t("settings.updateCheck");
		}
	};

	const handleUpdateAction = () => {
		if (status() === "downloading" || status() === "installing") {
			update.setDialogOpen(true);
			return;
		}
		void update.checkForUpdates({ openDialog: true });
	};

	return (
		<View class="gap-3">
			<SettingsSection>
				<View class="flex-row items-center gap-4 px-4 py-4">
					<View class="size-16 shrink-0 overflow-hidden rounded-2xl border border-border/60">
						<Image
							src={appIcon}
							testID="about-app-icon"
							class="size-full"
							style={{ objectFit: "cover" }}
						/>
					</View>
					<View class="min-w-0 gap-1">
						<Text class="font-sans text-lg font-semibold tracking-tight text-foreground">
							Pilo
						</Text>
						<Text class="font-sans text-xs leading-relaxed text-muted-foreground">
							{() => t("about.description")}
						</Text>
					</View>
				</View>
			</SettingsSection>
			<SettingsSection title={t("settings.application")}>
				<SettingsRow label={t("settings.version")}>
					<Text class="font-mono text-xs text-muted-foreground">{version}</Text>
				</SettingsRow>
				<SettingsRow label={t("settings.repository")} ghostEdge="both">
					<SettingsActionButton
						testID="settings-repository"
						onPress={() => {
							void openUrl(REPOSITORY_URL).catch((error: unknown) =>
								console.error("openUrl failed", error),
							);
						}}
					>
						<Icon name="Code2" size={14} />
						<Text class="font-sans text-xs">GitHub</Text>
						<Icon name="ExternalLink" size={14} class="opacity-60" />
					</SettingsActionButton>
				</SettingsRow>
				<SettingsRow label={t("settings.logDirectory")} ghostEdge="both">
					<SettingsActionButton
						testID="settings-open-log-directory"
						onPress={() => {
							void props.client
								.openLogDirectory()
								.catch((error: unknown) =>
									console.error("openLogDirectory failed", error),
								);
						}}
					>
						<Icon name="FolderOpen" size={14} />
						<Text class="font-sans text-xs">
							{t("settings.openLogDirectoryAction")}
						</Text>
						<Icon name="ExternalLink" size={14} class="opacity-60" />
					</SettingsActionButton>
				</SettingsRow>
			</SettingsSection>
			<SettingsSection title={t("settings.update")}>
				<SettingsRow
					label={t("settings.updateCheck")}
					helper={
						status() === "error" ? (update.error() ?? undefined) : undefined
					}
					ghostEdge="end"
				>
					<View class="flex-row flex-wrap items-center gap-2">
						{() =>
							status() === "latest" ? (
								<SettingsStatus muted icon="CheckCircle2">
									{t("settings.latest")}
								</SettingsStatus>
							) : status() === "available" && update.availableVersion() ? (
								<SettingsStatus>v{update.availableVersion()}</SettingsStatus>
							) : null
						}
						{() => (
							<SettingsActionButton
								testID="settings-update-check"
								disabled={status() === "checking"}
								onPress={handleUpdateAction}
							>
								{status() === "checking" ? (
									<Spinner class="size-3.5" />
								) : (
									<Icon name="RefreshCw" size={14} />
								)}
								<Text class="font-sans text-xs">{buttonLabel()}</Text>
							</SettingsActionButton>
						)}
						{update.isDev ? (
							<SettingsActionButton
								testID="settings-update-preview"
								onPress={() => update.previewUpdate()}
							>
								<Text class="font-sans text-xs">
									{() => t("settings.updatePreview")}
								</Text>
							</SettingsActionButton>
						) : null}
					</View>
				</SettingsRow>
				<SettingsRow label={t("settings.releaseNotes")} ghostEdge="both">
					<SettingsActionButton
						testID="settings-release-notes"
						onPress={() => {
							void openUrl(RELEASES_URL).catch((error: unknown) =>
								console.error("openUrl failed", error),
							);
						}}
					>
						<Text class="font-sans text-xs">GitHub Releases</Text>
						<Icon name="ExternalLink" size={14} class="opacity-60" />
					</SettingsActionButton>
				</SettingsRow>
			</SettingsSection>
			{ownedUpdate
				? () =>
						ownedUpdate.hasUpdate() ? (
							<UpdateDialog update={ownedUpdate} />
						) : null
				: null}
		</View>
	);
}
