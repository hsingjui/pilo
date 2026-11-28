import { signal, Text, View } from "nsh";

import type {
	DesktopCliApi,
	DesktopCliState,
	DesktopCliStatus,
} from "../shell/desktop-shell";
import { t } from "../shell/i18n";
import { Icon, type IconName } from "../ui/icon";
import { Spinner } from "../ui/spinner";
import {
	SettingsActionButton,
	SettingsRow,
	SettingsSection,
	SettingsStatus,
} from "./layout";

type CliAction = "install" | "repair" | "uninstall";

const STATE_ICONS: Record<DesktopCliState, IconName> = {
	ready: "CheckCircle2",
	not_installed: "Download",
	not_in_path: "CircleAlert",
	stale: "Wrench",
	conflict: "TriangleAlert",
	unavailable: "CircleAlert",
};

function stateLabel(state: DesktopCliState) {
	switch (state) {
		case "ready":
			return t("cli.stateReady");
		case "not_installed":
			return t("cli.stateNotInstalled");
		case "not_in_path":
			return t("cli.stateNotInPath");
		case "stale":
			return t("cli.stateStale");
		case "conflict":
			return t("cli.stateConflict");
		case "unavailable":
			return t("cli.stateUnavailable");
	}
}

function stateHelper(status: DesktopCliStatus) {
	const command = status.command;
	const dir = status.pathDir ?? "";
	switch (status.state) {
		case "not_installed":
			return t("cli.notInstalledHelp", { command });
		case "not_in_path":
			return t("cli.notInPathHelp", { command, dir });
		case "conflict":
			return t("cli.conflictHelp", { path: status.conflictPath ?? "" });
		case "unavailable":
			return t("cli.unavailableHelp");
		case "stale":
			switch (status.reason) {
				case "moved":
					return t("cli.staleMoved");
				case "other_app":
					return t("cli.staleOtherApp");
				case "outdated":
					return t("cli.staleOutdated");
				case "path_removed":
					return t("cli.stalePathRemoved", { dir });
				default:
					return t("cli.staleMissing", { command });
			}
		case "ready":
			return undefined;
	}
}

function outcomeNotice(status: DesktopCliStatus) {
	switch (status.outcome) {
		case "fallback":
			return t("cli.fallback", { dir: status.pathDir ?? "" });
		case "canceled":
			return t("cli.canceled");
		default:
			return null;
	}
}

/**
 * Installs the CLI bundled with the desktop app on the terminal PATH. The
 * version comes from running the bundled CLI's `version`; when that fails the
 * page still offers the actions and shows the version as unknown.
 */
export function CliPane(props: { cli: DesktopCliApi }) {
	const status = signal<DesktopCliStatus | null>(null);
	const busy = signal<CliAction | "refresh" | null>("refresh");
	const notice = signal<string | null>(null);
	const failure = signal<string | null>(null);

	const run = async (
		action: CliAction | "refresh",
		call: () => Promise<DesktopCliStatus>,
	) => {
		busy.set(action);
		failure.set(null);
		if (action !== "refresh") notice.set(null);
		try {
			const next = await call();
			status.set(next);
			if (action !== "refresh") notice.set(outcomeNotice(next));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			failure.set(t("cli.failed", { message }));
		} finally {
			busy.set(null);
		}
	};
	void run("refresh", () => props.cli.status());

	const actionButton = (
		action: CliAction,
		icon: IconName,
		label: () => string,
	) => (
		<SettingsActionButton
			testID={`settings-cli-${action}`}
			emphasized={action !== "uninstall"}
			disabled={busy() !== null}
			onPress={() => void run(action, () => props.cli[action]())}
		>
			{busy() === action ? (
				<Spinner class="size-3.5" />
			) : (
				<Icon name={icon} size={14} />
			)}
			<Text class="font-sans text-xs">{label()}</Text>
		</SettingsActionButton>
	);

	const version = (current: DesktopCliStatus) =>
		current.installedVersion ?? current.bundledVersion;

	return (
		<View class="gap-3">
			<SettingsSection
				title={t("cli.title")}
				actions={
					<SettingsActionButton
						testID="settings-cli-refresh"
						tooltip={t("cli.refresh")}
						disabled={busy() !== null}
						onPress={() => void run("refresh", () => props.cli.status())}
					>
						<Icon name="RefreshCw" size={14} />
					</SettingsActionButton>
				}
			>
				{() => {
					const current = status();
					if (!current) {
						return (
							<SettingsRow label={t("cli.status")}>
								<Spinner class="size-3.5" />
							</SettingsRow>
						);
					}
					const installed =
						current.state === "ready" ||
						current.state === "not_in_path" ||
						current.state === "stale" ||
						current.entryPath !== null;
					return (
						<View>
							<SettingsRow
								label={t("cli.status")}
								helper={stateHelper(current)}
							>
								<View testID="settings-cli-status">
									<SettingsStatus
										muted={current.state !== "ready"}
										icon={STATE_ICONS[current.state]}
									>
										{stateLabel(current.state)}
									</SettingsStatus>
								</View>
							</SettingsRow>
							<SettingsRow label={t("cli.command")}>
								<Text class="font-mono text-xs text-muted-foreground">
									{current.command}
								</Text>
							</SettingsRow>
							<SettingsRow label={t("cli.version")}>
								<Text
									testID="settings-cli-version"
									class="font-mono text-xs text-muted-foreground"
								>
									{version(current) ?? t("cli.versionUnknown")}
								</Text>
							</SettingsRow>
							{current.entryPath ? (
								<SettingsRow label={t("cli.location")}>
									<Text
										testID="settings-cli-location"
										class="font-mono text-xs text-muted-foreground"
									>
										{current.entryPath}
									</Text>
								</SettingsRow>
							) : null}
							{current.shadowedBy ? (
								<SettingsRow
									label={t("cli.shadowedTitle")}
									helper={t("cli.shadowed", {
										path: current.shadowedBy,
										command: current.command,
									})}
								>
									<SettingsStatus muted icon="TriangleAlert">
										{t("cli.stateShadowed")}
									</SettingsStatus>
								</SettingsRow>
							) : null}
							<SettingsRow
								label={t("cli.actions")}
								helper={failure() ?? notice() ?? undefined}
								ghostEdge="end"
							>
								<View class="flex-row flex-wrap items-center gap-2">
									{current.state === "not_installed" ||
									(current.state === "conflict" && current.entryPath === null)
										? actionButton("install", "Download", () =>
												t("cli.install"),
											)
										: null}
									{current.state === "stale" || current.state === "not_in_path"
										? actionButton("repair", "Wrench", () => t("cli.repair"))
										: null}
									{installed
										? actionButton("uninstall", "Trash2", () =>
												t("cli.uninstall"),
											)
										: null}
								</View>
							</SettingsRow>
						</View>
					);
				}}
			</SettingsSection>
		</View>
	);
}
