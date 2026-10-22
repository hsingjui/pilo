import { useConfigurationRevision } from "@/lib/use-configuration-revision";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
	getDesktopAutostart,
	getDesktopExitOnClose,
	isAutostartMode,
	setDesktopAutostart,
	setDesktopExitOnClose,
	type AutostartMode,
} from "@/lib/desktop-integration";
import { cn } from "@/lib/utils";
import {
	Button,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Switch,
} from "@/ui";
import {
	SETTINGS_CONTROL_CLASS,
	SettingsRow,
	SettingsSection,
} from "./compact-layout";

export function DesktopSettings() {
	const configurationRevision = useConfigurationRevision();
	const { t } = useTranslation();
	const [mode, setMode] = useState<AutostartMode | null>(null);
	const [saving, setSaving] = useState(false);
	const [loadError, setLoadError] = useState(false);

	/* oxlint-disable react/exhaustive-effect-dependencies -- Host configuration revisions intentionally reload externally owned settings. */
	useEffect(() => {
		let active = true;
		void getDesktopAutostart().then(
			(value) => {
				if (active) setMode(value);
			},
			(error) => {
				console.error("Failed to load desktop startup settings", error);
				if (active) setLoadError(true);
			},
		);
		return () => {
			active = false;
		};
	}, [configurationRevision]);
	/* oxlint-enable react/exhaustive-effect-dependencies */

	const retry = async () => {
		setLoadError(false);
		try {
			setMode(await getDesktopAutostart());
		} catch (error) {
			console.error("Failed to load desktop startup settings", error);
			setLoadError(true);
		}
	};

	const changeMode = async (value: string) => {
		if (!isAutostartMode(value) || saving) return;
		setSaving(true);
		try {
			setMode(await setDesktopAutostart(value));
		} catch (error) {
			console.error("Failed to save desktop startup settings", error);
			toast.error(t("desktop.saveFailed"));
		} finally {
			setSaving(false);
		}
	};

	return (
		<SettingsSection title={t("desktop.startupAndTray")}>
			<SettingsRow label={t("desktop.autostart")}>
				{loadError ? (
					<div role="alert" className="flex flex-wrap items-center gap-2">
						<span className="text-xs text-destructive">
							{t("desktop.loadFailed")}
						</span>
						<Button variant="ghost" size="sm" onClick={() => void retry()}>
							{t("common.retry")}
						</Button>
					</div>
				) : (
					<Select
						value={mode ?? ""}
						disabled={mode === null || saving}
						onValueChange={(value) => void changeMode(value)}
					>
						<SelectTrigger
							aria-label={t("desktop.autostart")}
							className={cn(
								SETTINGS_CONTROL_CLASS,
								"w-full sm:w-[220px] pointer-coarse:min-h-11",
							)}
						>
							<SelectValue placeholder={t("common.loading")} />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="disabled">
								{t("desktop.autostartDisabled")}
							</SelectItem>
							<SelectItem value="window">
								{t("desktop.autostartWindow")}
							</SelectItem>
							<SelectItem value="tray">{t("desktop.autostartTray")}</SelectItem>
						</SelectContent>
					</Select>
				)}
			</SettingsRow>
			<ExitOnCloseSetting />
		</SettingsSection>
	);
}

function ExitOnCloseSetting() {
	const configurationRevision = useConfigurationRevision();
	const { t } = useTranslation();
	const [enabled, setEnabled] = useState<boolean | null>(null);
	const [saving, setSaving] = useState(false);
	const [loadError, setLoadError] = useState(false);

	/* oxlint-disable react/exhaustive-effect-dependencies -- Host configuration revisions intentionally reload externally owned settings. */
	useEffect(() => {
		let active = true;
		void getDesktopExitOnClose().then(
			(value) => {
				if (active) setEnabled(value);
			},
			(error) => {
				console.error("Failed to load desktop close settings", error);
				if (active) setLoadError(true);
			},
		);
		return () => {
			active = false;
		};
	}, [configurationRevision]);
	/* oxlint-enable react/exhaustive-effect-dependencies */

	const retry = async () => {
		setLoadError(false);
		try {
			setEnabled(await getDesktopExitOnClose());
		} catch (error) {
			console.error("Failed to load desktop close settings", error);
			setLoadError(true);
		}
	};

	const changeEnabled = async (value: boolean) => {
		if (saving) return;
		setSaving(true);
		try {
			setEnabled(await setDesktopExitOnClose(value));
		} catch (error) {
			console.error("Failed to save desktop close settings", error);
			toast.error(t("desktop.closeSaveFailed"));
		} finally {
			setSaving(false);
		}
	};

	return (
		<SettingsRow
			label={
				<label htmlFor="desktop-exit-on-close">
					{t("desktop.exitOnClose")}
				</label>
			}
		>
			{loadError ? (
				<div role="alert" className="flex flex-wrap items-center gap-2">
					<span className="text-xs text-destructive">
						{t("desktop.closeLoadFailed")}
					</span>
					<Button variant="ghost" size="sm" onClick={() => void retry()}>
						{t("common.retry")}
					</Button>
				</div>
			) : (
				<Switch
					id="desktop-exit-on-close"
					checked={enabled ?? false}
					disabled={enabled === null || saving}
					onCheckedChange={(value) => void changeEnabled(value)}
				/>
			)}
		</SettingsRow>
	);
}
