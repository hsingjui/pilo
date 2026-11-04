import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { listConnectionCatalog } from "@/lib/api/connections";
import { connectionLabel } from "@/lib/api/projects";
import { listenRuntimeEvents, type Connection } from "@/lib/api/pi-runtime";
import { tauriPiloClient } from "@/lib/api/tauri-pilo-client";
import { useNextPromptSettings } from "@/lib/use-next-prompt-settings";
import { ConnectionModelCatalog } from "./connection-model-catalog";
import { NextPromptSettingsFields } from "./next-prompt-settings";
import { SettingsSection, SETTINGS_CONTAINER_CLASS } from "./compact-layout";

function ConnectionSettings({ connection }: { connection: Connection }) {
	const config = useNextPromptSettings(tauriPiloClient, connection.id);
	useEffect(() => {
		let disposed = false;
		let stop: (() => void) | undefined;
		void listenRuntimeEvents(config.handleEvent)
			.then((unlisten) => {
				if (disposed) unlisten();
				else stop = unlisten;
			})
			.catch(() => undefined);
		return () => {
			disposed = true;
			stop?.();
		};
	}, [config.handleEvent]);
	return (
		<ConnectionModelCatalog client={tauriPiloClient} connection={connection}>
			{(models, refresh) => (
				<NextPromptSettingsFields
					config={config}
					models={models}
					modelActions={refresh}
					connectionName={connectionLabel(connection)}
				/>
			)}
		</ConnectionModelCatalog>
	);
}

export function ConnectionNextPromptSettings() {
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
				{t("settings.nextPromptDescription")}
			</p>
			{error ? (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			) : null}
			<SettingsSection title={t("settings.nextPromptModel")}>
				{connections.map((connection) => (
					<ConnectionSettings key={connection.id} connection={connection} />
				))}
			</SettingsSection>
		</div>
	);
}
