import { useConfigurationRevision } from "@/lib/use-configuration-revision";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { listConnectionCatalog } from "@/lib/api/connections";
import { tauriPiloClient } from "@/lib/api/tauri-pilo-client";
import { userErrorMessage } from "@/lib/app-error";
import type { Connection, PiModel } from "@/lib/api/pi-runtime";
import { connectionLabel } from "@/lib/api/projects";
import {
	listConnectionNamingModels,
	setConnectionNamingModel,
} from "@/lib/api/sessions";
import { cn } from "@/lib/utils";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/ui";

import {
	SETTINGS_CONTAINER_CLASS,
	SETTINGS_CONTROL_CLASS,
	SettingsRow,
	SettingsSection,
} from "./compact-layout";

import { ConnectionModelCatalog } from "./connection-model-catalog";

type NamingSelection = Pick<PiModel, "provider" | "id">;

function modelKey(model: NamingSelection) {
	return JSON.stringify([model.provider, model.id]);
}

export function SessionNamingSettings() {
	const configurationRevision = useConfigurationRevision();
	const [connections, setConnections] = useState<Connection[]>([]);
	const [selections, setSelections] = useState<Map<string, NamingSelection>>(
		() => new Map(),
	);
	const [loading, setLoading] = useState(true);
	const [busyConnectionId, setBusyConnectionId] = useState<string | null>(null);
	const { t } = useTranslation();

	/* oxlint-disable react/exhaustive-effect-dependencies -- Host configuration revisions intentionally reload externally owned settings. */
	useEffect(() => {
		let active = true;
		void Promise.all([listConnectionCatalog(), listConnectionNamingModels()])
			.then(([catalog, namingModels]) => {
				if (!active) return;
				setConnections(catalog);
				setSelections(
					new Map(
						namingModels.map((item) => [
							item.connectionId,
							{ provider: item.provider, id: item.modelId },
						]),
					),
				);
			})
			.catch((error) => {
				if (active) {
					toast.error(t("settings.loadNamingSettingsFailed"), {
						description: userErrorMessage(error),
					});
				}
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, [t, configurationRevision]);
	/* oxlint-enable react/exhaustive-effect-dependencies */

	const saveModel = async (connectionId: string, model: PiModel | null) => {
		setBusyConnectionId(connectionId);
		try {
			await setConnectionNamingModel(connectionId, model);
			setSelections((current) => {
				const next = new Map(current);
				if (model) next.set(connectionId, model);
				else next.delete(connectionId);
				return next;
			});
		} catch (error) {
			toast.error(t("settings.saveNamingModelFailed"), {
				description: userErrorMessage(error),
			});
		} finally {
			setBusyConnectionId(null);
		}
	};

	return (
		<div className={SETTINGS_CONTAINER_CLASS}>
			<SettingsSection title={t("settings.namingModel")}>
				{loading ? (
					<div className="px-3 py-5 text-xs text-muted-foreground">
						{t("common.loading")}
					</div>
				) : connections.length === 0 ? (
					<div className="px-3 py-5 text-xs text-muted-foreground">
						{t("settings.noConnections")}
					</div>
				) : (
					connections.map((connection) => {
						const selected = selections.get(connection.id) ?? null;
						const busy = busyConnectionId === connection.id;
						return (
							<ConnectionModelCatalog
								client={tauriPiloClient}
								key={connection.id}
								connection={connection}
							>
								{(models, refresh) => (
									<SettingsRow label={connectionLabel(connection)}>
										<Select
											value={selected ? modelKey(selected) : "disabled"}
											disabled={busy}
											onValueChange={(value) => {
												if (value === "disabled") {
													void saveModel(connection.id, null);
													return;
												}
												const model = models.find(
													(candidate) => modelKey(candidate) === value,
												);
												if (model) void saveModel(connection.id, model);
											}}
										>
											<SelectTrigger
												className={cn(
													SETTINGS_CONTROL_CLASS,
													"w-[320px] max-w-full",
												)}
											>
												<SelectValue placeholder={t("settings.selectModel")}>
													{selected &&
													!models.some(
														(model) => modelKey(model) === modelKey(selected),
													)
														? t("settings.modelUnavailable")
														: undefined}
												</SelectValue>
											</SelectTrigger>
											<SelectContent className="max-h-80">
												<SelectItem value="disabled">
													{t("settings.noAutomaticNaming")}
												</SelectItem>
												{models.map((model) => (
													<SelectItem
														key={modelKey(model)}
														value={modelKey(model)}
													>
														{model.name} · {model.provider}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
										{refresh}
									</SettingsRow>
								)}
							</ConnectionModelCatalog>
						);
					})
				)}
			</SettingsSection>
		</div>
	);
}
