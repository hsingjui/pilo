import { type Accessor, signal, Text, View } from "nsh";

import type { ConnectionNamingModel } from "@/lib/api/sessions-types";
import type { AppState } from "../state/app-state";
import { t } from "../app/i18n";
import {
	ConnectionModelLists,
	ConnectionModelSelect,
	connectionLabel,
	modelKey,
	paneConnections,
} from "./connection-settings";
import { SettingsRow, SettingsSection } from "./layout";
import type { SettingsClient } from "./settings-dialog";

/**
 * Session naming per connection: the model that writes a session's title,
 * unset naming nothing automatically.
 */
export function SessionNamingPane(props: {
	state: Accessor<AppState>;
	client: SettingsClient;
}) {
	const lists = new ConnectionModelLists(props.client);
	const selections = signal<Record<string, ConnectionNamingModel>>({});
	const loaded = signal(false);
	const ensure = () => {
		if (loaded()) return;
		loaded.set(true);
		props.client
			.loadNamingModels()
			.then((models) =>
				selections.set(
					Object.fromEntries(
						models.map((model) => [model.connectionId, model]),
					),
				),
			)
			.catch((error: unknown) => {
				console.error(String(error));
			});
	};
	ensure();
	const save = (
		connectionId: string,
		provider: string | null,
		modelId: string | null,
	) => {
		props.client
			.saveNamingModel(connectionId, provider, modelId)
			.then((model) => {
				const next = { ...selections() };
				if (model) next[connectionId] = model;
				else delete next[connectionId];
				selections.set(next);
			})
			.catch((error: unknown) => {
				console.error(t("settings.saveNamingModelFailed"), error);
			});
	};
	return (
		<SettingsSection title={t("settings.namingModel")}>
			{() => {
				const connections = paneConnections(props.state().projects);
				if (connections.length === 0)
					return (
						<View class="px-3 py-4">
							<Text class="text-sm text-muted-foreground">
								{t("settings.noConnections")}
							</Text>
						</View>
					);
				return connections.map((connection) => {
					const selected = () => selections()[connection.id];
					return (
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
								onPick={(model) =>
									save(
										connection.id,
										model ? model.provider : null,
										model ? model.id : null,
									)
								}
							/>
						</SettingsRow>
					);
				});
			}}
		</SettingsSection>
	);
}
