import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { listConnectionCatalog } from "@/lib/api/connections";
import { connectionLabel } from "@/lib/api/projects";
import { type Connection } from "@/lib/api/pi-runtime";
import { tauriPiloClient } from "@/lib/api/tauri-pilo-client";
import { usePromptEnhancementSettings } from "@/lib/use-prompt-enhancement-settings";
import { ConnectionModelCatalog } from "./connection-model-catalog";
import { PromptEnhancementSettingsFields } from "./prompt-enhancement-settings";
import { SettingsSection, SETTINGS_CONTAINER_CLASS } from "./compact-layout";

function ConnectionSettings({ connection }: { connection: Connection }) {
	const config = usePromptEnhancementSettings(tauriPiloClient, connection.id);
	return (
		<ConnectionModelCatalog client={tauriPiloClient} connection={connection}>
			{(models, refresh) => (
				<PromptEnhancementSettingsFields
					config={config}
					models={models}
					modelActions={refresh}
					connectionName={connectionLabel(connection)}
				/>
			)}
		</ConnectionModelCatalog>
	);
}

/** One row per Connection: the setting is shared by desktop and the WebUI. */
export function ConnectionPromptEnhancementSettings() {
	const { t } = useTranslation();
	const [connections, setConnections] = useState<Connection[]>([]);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let disposed = false;
		void listConnectionCatalog()
			.then((catalog) => {
				if (!disposed) setConnections(catalog);
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
				{connections.map((connection) => (
					<ConnectionSettings key={connection.id} connection={connection} />
				))}
			</SettingsSection>
		</div>
	);
}
