import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { listConnectionCatalog } from "@/lib/api/connections";
import { connectionLabel } from "@/lib/api/projects";
import type { Connection } from "@/lib/api/pi-runtime";
import { tauriPiloClient } from "@/lib/api/tauri-pilo-client";
import { ConnectionModelCatalog } from "./connection-model-catalog";
import { CacheKeepAliveSettingsFields } from "./cache-keep-alive-settings";
import { SETTINGS_CONTAINER_CLASS } from "./compact-layout";

export function ConnectionCacheKeepAliveSettings() {
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
				{t("settings.cacheKeepAliveDescription")}
			</p>
			{error ? (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			) : null}
			{connections.map((connection) => (
				<ConnectionModelCatalog
					key={connection.id}
					client={tauriPiloClient}
					connection={connection}
				>
					{(models, refresh) => (
						<CacheKeepAliveSettingsFields
							client={tauriPiloClient}
							connectionId={connection.id}
							connectionName={connectionLabel(connection)}
							models={models}
							modelActions={refresh}
						/>
					)}
				</ConnectionModelCatalog>
			))}
		</div>
	);
}
