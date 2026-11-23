import { appInfo, Image, openUrl, signal, Text, View } from "nsh";
import {
	checkForUpdate,
	downloadUpdate,
	installAndRestart,
	shellInfo,
} from "nsh/updater";

import { userErrorMessage } from "@shared/app-error";
import { t } from "../app/i18n";
import appIcon from "../assets/app-icon.png";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Spinner } from "../ui/spinner";
import {
	SETTINGS_TEXT_BUTTON_CLASS,
	SettingsRow,
	SettingsSection,
	SettingsStatus,
} from "./layout";
import type { SettingsClient } from "./settings-dialog";

const REPOSITORY_URL = "https://github.com/hsingjui/pilo";
const RELEASES_URL = `${REPOSITORY_URL}/releases`;

type UpdateStatus =
	| "idle"
	| "checking"
	| "latest"
	| "available"
	| "downloading"
	| "installing"
	| "error";

/** The updater's error as a friendly key, like React's `formatUpdateError`. */
function updateErrorMessage(caught: unknown): string {
	const message = userErrorMessage(caught);
	if (/public key|signature/i.test(message))
		return t("about.updateConfigUnavailable");
	if (/network|fetch/i.test(message))
		return t("about.updateServiceUnavailable");
	return `${t("about.updateFailed")} · ${message}`;
}

/**
 * Version, build and updater, as the WebUI `AboutSettings` pane. nsh has no
 * update dialog: an available update downloads and restarts from the same
 * button. The dev-only preview action is a React-debug control and stays out.
 */
export function AboutPane(props: { client: SettingsClient }) {
	const info = appInfo();
	const shell = shellInfo();
	const status = signal<UpdateStatus>("idle");
	const updateError = signal<string | null>(null);
	const progress = signal<number | null>(null);
	const availableVersion = signal<string | null>(null);

	const check = async () => {
		if (
			status() === "checking" ||
			status() === "downloading" ||
			status() === "installing"
		)
			return;
		status.set("checking");
		updateError.set(null);
		try {
			const update = await checkForUpdate();
			if (!update) {
				status.set("latest");
				return;
			}
			availableVersion.set(update.version);
			status.set("available");
			if (!update.canInstall) {
				void openUrl(update.url);
				return;
			}
			status.set("downloading");
			progress.set(null);
			await downloadUpdate((event) => {
				progress.set(
					event.total ? Math.round((event.received / event.total) * 100) : null,
				);
			});
			status.set("installing");
			await installAndRestart();
		} catch (caught) {
			updateError.set(updateErrorMessage(caught));
			status.set("error");
		}
	};

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

	return (
		<View class="gap-3">
			<SettingsSection>
				<View class="flex-row items-center gap-4 px-4 py-4">
					<View class="size-16 shrink-0 items-center justify-center rounded-2xl border border-border/60 bg-background">
						<Image
							src={appIcon}
							testID="about-app-icon"
							class="size-14 rounded-xl"
						/>
					</View>
					<View class="min-w-0 gap-1">
						<View class="flex-row items-center gap-2">
							<Text class="font-sans text-lg font-semibold tracking-tight text-foreground">
								Pilo
							</Text>
							<SettingsStatus>v{info.version}</SettingsStatus>
						</View>
						<Text class="font-sans text-xs leading-relaxed text-muted-foreground">
							{() => t("about.description")}
						</Text>
					</View>
				</View>
			</SettingsSection>
			<SettingsSection title={t("settings.application")}>
				<SettingsRow label={t("settings.version")}>
					<Text class="font-mono text-xs text-muted-foreground">
						{`${info.version} · build ${info.build} · nsh ${shell.nshVersion}`}
					</Text>
				</SettingsRow>
				<SettingsRow label={t("settings.repository")} ghostEdge="both">
					<Button
						testID="settings-repository"
						variant="ghost"
						size="sm"
						class={`${SETTINGS_TEXT_BUTTON_CLASS} text-muted-foreground`}
						onPress={() => {
							void openUrl(REPOSITORY_URL).catch((error: unknown) =>
								console.error("openUrl failed", error),
							);
						}}
					>
						<Icon name="Code2" size={14} />
						<Text class="font-sans text-xs">GitHub</Text>
						<Icon name="ExternalLink" size={14} class="opacity-60" />
					</Button>
				</SettingsRow>
				<SettingsRow label={t("settings.logDirectory")} ghostEdge="both">
					<Button
						testID="settings-open-log-directory"
						variant="ghost"
						size="sm"
						class={`${SETTINGS_TEXT_BUTTON_CLASS} text-muted-foreground`}
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
					</Button>
				</SettingsRow>
			</SettingsSection>
			<SettingsSection title={t("settings.update")}>
				<SettingsRow
					label={t("settings.updateCheck")}
					helper={updateError() ?? undefined}
				>
					<View class="flex-row items-center gap-2">
						{status() === "latest" ? (
							<SettingsStatus muted>
								<Icon name="CheckCircle2" size={12} />
								{t("settings.latest")}
							</SettingsStatus>
						) : status() === "available" && availableVersion() ? (
							<SettingsStatus>v{availableVersion()}</SettingsStatus>
						) : null}
						{() => (
							<Button
								testID="settings-update-check"
								variant="ghost"
								size="sm"
								class={`${SETTINGS_TEXT_BUTTON_CLASS} text-muted-foreground hover:text-foreground`}
								disabled={
									status() === "checking" ||
									status() === "downloading" ||
									status() === "installing"
								}
								onPress={() => void check()}
							>
								{status() === "checking" ? (
									<Spinner class="size-3.5" />
								) : (
									<Icon name="RefreshCw" size={14} />
								)}
								<Text class="font-sans text-xs">{buttonLabel()}</Text>
							</Button>
						)}
					</View>
				</SettingsRow>
				<SettingsRow label={t("settings.releaseNotes")} ghostEdge="both">
					<Button
						testID="settings-release-notes"
						variant="ghost"
						size="sm"
						class={`${SETTINGS_TEXT_BUTTON_CLASS} text-muted-foreground`}
						onPress={() => {
							void openUrl(RELEASES_URL).catch((error: unknown) =>
								console.error("openUrl failed", error),
							);
						}}
					>
						<Text class="font-sans text-xs">GitHub Releases</Text>
						<Icon name="ExternalLink" size={14} class="opacity-60" />
					</Button>
				</SettingsRow>
			</SettingsSection>
		</View>
	);
}
