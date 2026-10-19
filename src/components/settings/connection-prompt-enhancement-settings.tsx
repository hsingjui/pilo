import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { listConnectionCatalog } from "@/lib/api/connections";
import { connectionLabel } from "@/lib/api/projects";
import { type Connection, type PiModel } from "@/lib/api/pi-runtime";
import { tauriPiloClient } from "@/lib/api/tauri-pilo-client";
import { usePromptEnhancementSettings } from "@/lib/use-prompt-enhancement-settings";
import { PromptEnhancementSettingsFields } from "./prompt-enhancement-settings";
import { SettingsSection, SETTINGS_CONTAINER_CLASS } from "./compact-layout";

function ConnectionSettings({
	connection,
	models,
}: {
	connection: Connection;
	models: readonly PiModel[];
}) {
	const config = usePromptEnhancementSettings(tauriPiloClient, connection.id);
	return (
		<PromptEnhancementSettingsFields
			config={config}
			models={models}
			connectionName={connectionLabel(connection)}
		/>
	);
}

/** One row per Connection: the setting is shared by desktop and the WebUI. */
export function ConnectionPromptEnhancementSettings() {
	const { t } = useTranslation();
	const [catalog, setCatalog] = useState<{
		connections: Connection[];
		models: Map<string, PiModel[]>;
	}>({ connections: [], models: new Map() });
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let disposed = false;
		void Promise.all([listConnectionCatalog(), tauriPiloClient.bootstrap()])
			.then(async ([connections, snapshot]) => {
				const caches = await Promise.all(
					snapshot.projects.map(async (project) => ({
						connectionId: project.connection.id,
						catalog: await tauriPiloClient.loadModels(project.id),
					})),
				);
				if (disposed) return;
				const models = new Map<string, PiModel[]>();
				for (const cache of caches)
					models.set(cache.connectionId, [
						...(models.get(cache.connectionId) ?? []),
						...(cache.catalog?.models ?? []),
					]);
				setCatalog({ connections, models });
			})
			.catch((cause: unknown) => {
				if (!disposed)
					setError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			disposed = true;
		};
	}, []);
	return (
		<div className={SETTINGS_CONTAINER_CLASS}>
			<p className="text-xs leading-5 text-muted-foreground">
				{t("settings.promptEnhancementDescription")}
			</p>
			{error ? (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			) : null}
			<SettingsSection title={t("settings.promptEnhancementModel")}>
				{catalog.connections.map((connection) => (
					<ConnectionSettings
						key={connection.id}
						connection={connection}
						models={catalog.models.get(connection.id) ?? []}
					/>
				))}
			</SettingsSection>
		</div>
	);
}
