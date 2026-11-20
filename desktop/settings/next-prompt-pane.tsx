import { type Accessor, signal, Text, View } from "nsh";

import type { NextPromptSettings } from "@/lib/next-prompt-types";
import type { AppState } from "../state/app-state";
import { t } from "../app/i18n";
import { Switch } from "../ui/switch";
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
 * Prompt suggestions per connection: the switch and the model that writes
 * them, `null` following the chat's model.
 */
export function NextPromptPane(props: {
	state: Accessor<AppState>;
	client: SettingsClient;
}) {
	const lists = new ConnectionModelLists(props.client);
	const settings = signal<Record<string, NextPromptSettings>>({});
	const loaded = new Set<string>();
	const ensure = (connectionId: string) => {
		if (loaded.has(connectionId)) return;
		loaded.add(connectionId);
		props.client
			.loadNextPromptSettings(connectionId)
			.then((next) => settings.set({ ...settings(), [connectionId]: next }))
			.catch((error: unknown) => {
				console.error(String(error));
			});
	};
	const save = (
		connectionId: string,
		patch: { enabled?: boolean; model?: NextPromptSettings["model"] },
	) => {
		const current = settings()[connectionId];
		props.client
			.saveNextPromptSettings(
				connectionId,
				patch.enabled ?? current?.enabled ?? false,
				patch.model === undefined ? (current?.model ?? null) : patch.model,
			)
			.then((next) => settings.set({ ...settings(), [connectionId]: next }))
			.catch((error: unknown) => {
				console.error(String(error));
			});
	};
	return (
		<SettingsSection title={t("settings.nextPrompt")}>
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
					ensure(connection.id);
					const current = () => settings()[connection.id];
					return (
						<SettingsRow label={connectionLabel(connection)}>
							<ConnectionModelSelect
								testID={`settings-next-prompt-model-${connection.id}`}
								connection={connection}
								lists={lists}
								noneValue="follow"
								noneTitle={t("settings.nextPromptFollowModel")}
								value={
									current()?.model
										? modelKey(current()!.model!.provider, current()!.model!.id)
										: "follow"
								}
								onPick={(model) =>
									save(connection.id, {
										model: model
											? { provider: model.provider, id: model.id }
											: null,
									})
								}
							/>
							<Switch
								testID={`settings-next-prompt-${connection.id}`}
								checked={current()?.enabled ?? false}
								onChange={({ checked }) =>
									save(connection.id, { enabled: checked })
								}
							/>
						</SettingsRow>
					);
				});
			}}
		</SettingsSection>
	);
}
