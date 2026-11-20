import { type Accessor, cleanup, effect, signal, Text, View } from "nsh";

import type { Connection } from "@/lib/api/pi-runtime-types";
import type { ConnectionNamingModel } from "@/lib/api/sessions-types";
import type { AppState } from "../state/app-state";
import { t } from "../app/i18n";
import {
	ConnectionModelLists,
	ConnectionModelSelect,
	connectionLabel,
	modelKey,
	paneConnectionCatalog,
	settingsErrorMessage,
} from "./connection-settings";
import { SettingsRow, SettingsSection } from "./layout";
import type { SettingsClient } from "./settings-dialog";

/**
 * Session naming per connection: the model that writes a session's title,
 * unset naming nothing automatically. Mirrors `SessionNamingSettings` —
 * every configured connection, a loading row, the saving connection's
 * select disabled, and a reload on `configuration_changed` (the React
 * version re-ran on its configuration revision bump).
 */
export function SessionNamingPane(props: {
	state: Accessor<AppState>;
	client: SettingsClient;
}) {
	const lists = new ConnectionModelLists(props.client);
	const connections = signal<Connection[]>([]);
	const loading = signal(true);
	const selections = signal<Record<string, ConnectionNamingModel>>({});
	const busy = signal<Record<string, boolean>>({});
	const errors = signal<Record<string, string | undefined>>({});
	let alive = true;
	cleanup(() => {
		alive = false;
	});

	const setError = (connectionId: string, error: string | null) =>
		errors.set({ ...errors(), [connectionId]: error ?? undefined });
	const load = async () => {
		const [catalog, models] = await Promise.all([
			paneConnectionCatalog(props.client),
			props.client.loadNamingModels(),
		]);
		if (!alive) return;
		selections.set(
			Object.fromEntries(models.map((model) => [model.connectionId, model])),
		);
		connections.set(catalog);
		for (const connection of catalog) void lists.state(connection.id);
	};
	void load()
		.catch((error: unknown) => {
			if (alive) errors.set({ __catalog: settingsErrorMessage(error) });
		})
		.finally(() => {
			if (alive) loading.set(false);
		});

	// React re-loaded on its configuration revision; the runtime event is its
	// equivalent here.
	effect(() => {
		let stop: (() => void) | undefined;
		let disposed = false;
		void props.client
			.connectEvents({
				onMessage(message) {
					if (message.type !== "events") return;
					for (const event of message.events)
						if (event.type === "configuration_changed") void load();
				},
				onStatus() {},
			})
			.then((unlisten) => {
				if (disposed) unlisten();
				else stop = unlisten;
			})
			.catch(() => undefined);
		return () => {
			disposed = true;
			stop?.();
		};
	});

	const save = (
		connection: Connection,
		provider: string | null,
		modelId: string | null,
	) => {
		const connectionId = connection.id;
		if (busy()[connectionId]) return;
		busy.set({ ...busy(), [connectionId]: true });
		props.client
			.saveNamingModel(connectionId, provider, modelId)
			.then((model) => {
				if (!alive) return;
				const next = { ...selections() };
				if (model) next[connectionId] = model;
				else delete next[connectionId];
				selections.set(next);
				setError(connectionId, null);
			})
			.catch((error: unknown) =>
				setError(connectionId, settingsErrorMessage(error)),
			)
			.finally(() => {
				if (alive) busy.set({ ...busy(), [connectionId]: false });
			});
	};

	return (
		<SettingsSection title={t("settings.namingModel")}>
			{() => {
				if (loading())
					return (
						<View class="px-3 py-5">
							<Text class="text-xs text-muted-foreground">
								{t("common.loading")}
							</Text>
						</View>
					);
				if (connections().length === 0)
					return (
						<View class="px-3 py-5">
							<Text class="font-sans text-xs text-muted-foreground">
								{errors()["__catalog"] ?? t("settings.noConnections")}
							</Text>
						</View>
					);
				return connections().flatMap((connection) => {
					const selected = () => selections()[connection.id];
					const row = (
						<SettingsRow label={connectionLabel(connection)}>
							<ConnectionModelSelect
								testID={`settings-naming-model-${connection.id}`}
								connection={connection}
								lists={lists}
								noneValue="disabled"
								noneTitle={t("settings.noAutomaticNaming")}
								value={
									selected()
										? modelKey(selected()!.provider, selected()!.modelId)
										: "disabled"
								}
								disabled={busy()[connection.id]}
								onPick={(model) =>
									save(
										connection,
										model ? model.provider : null,
										model ? model.id : null,
									)
								}
							/>
						</SettingsRow>
					);
					const error = errors()[connection.id];
					return error
						? [
								row,
								<View class="border-b border-border/60 px-3 py-2 last:border-b-0">
									<Text class="text-xs text-destructive">{error}</Text>
								</View>,
							]
						: [row];
				});
			}}
		</SettingsSection>
	);
}
