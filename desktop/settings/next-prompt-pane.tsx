import { type Accessor, cleanup, effect, signal, Text, View } from "nsh";

import type { Connection } from "@/lib/api/pi-runtime-types";
import type { NextPromptSettings } from "@/lib/next-prompt-types";
import type { AppState } from "../state/app-state";
import { t } from "../app/i18n";
import { Switch } from "../ui/switch";
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
 * Prompt suggestions per connection: the switch and the model that writes
 * them, `null` following the chat's model. Mirrors
 * `ConnectionNextPromptSettings` — every configured connection, live
 * `next_prompt_settings_changed` events, busy rows disabled while saving.
 */
export function NextPromptPane(props: {
	state: Accessor<AppState>;
	client: SettingsClient;
}) {
	const lists = new ConnectionModelLists(props.client);
	const connections = signal<Connection[]>([]);
	const catalogError = signal<string | null>(null);
	const settings = signal<Record<string, NextPromptSettings>>({});
	const busy = signal<Record<string, boolean>>({});
	const errors = signal<Record<string, string | undefined>>({});
	let alive = true;
	cleanup(() => {
		alive = false;
	});

	const mergeSettings = (next: NextPromptSettings) => {
		const current = settings()[next.connectionId];
		if (current && current.updatedAtMs > next.updatedAtMs) return;
		settings.set({ ...settings(), [next.connectionId]: next });
	};
	const setError = (connectionId: string, error: string | null) =>
		errors.set({ ...errors(), [connectionId]: error ?? undefined });
	const loadSettings = (connection: Connection) => {
		props.client
			.loadNextPromptSettings(connection.id)
			.then(mergeSettings)
			.catch((error: unknown) => {
				if (alive) setError(connection.id, settingsErrorMessage(error));
			});
	};

	void paneConnectionCatalog(props.client)
		.then((catalog) => {
			if (!alive) return;
			connections.set(catalog);
			for (const connection of catalog) {
				void lists.state(connection.id);
				loadSettings(connection);
			}
		})
		.catch((error: unknown) => {
			if (alive) catalogError.set(settingsErrorMessage(error));
		});

	effect(() => {
		let stop: (() => void) | undefined;
		let disposed = false;
		void props.client
			.connectEvents({
				onMessage(message) {
					if (message.type !== "events") return;
					for (const event of message.events)
						if (event.type === "next_prompt_settings_changed")
							mergeSettings(event.settings);
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
		patch: { enabled?: boolean; model?: NextPromptSettings["model"] },
	) => {
		const connectionId = connection.id;
		if (busy()[connectionId]) return;
		const current = settings()[connectionId];
		busy.set({ ...busy(), [connectionId]: true });
		props.client
			.saveNextPromptSettings(
				connectionId,
				patch.enabled ?? current?.enabled ?? false,
				patch.model === undefined ? (current?.model ?? null) : patch.model,
			)
			.then((next) => {
				mergeSettings(next);
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
		<View class="min-w-0 gap-3">
			<Text class="text-xs leading-5 text-muted-foreground">
				{t("settings.nextPromptDescription")}
			</Text>
			{() =>
				catalogError() ? (
					<Text class="text-sm text-destructive">{catalogError()}</Text>
				) : null
			}
			<SettingsSection title={t("settings.nextPromptModel")}>
				{() =>
					connections().flatMap((connection) => {
						const current = () => settings()[connection.id];
						const disabled = () => !current() || busy()[connection.id];
						const row = (
							<SettingsRow label={connectionLabel(connection)}>
								<ConnectionModelSelect
									testID={`settings-next-prompt-model-${connection.id}`}
									connection={connection}
									lists={lists}
									noneValue="follow"
									noneTitle={t("settings.nextPromptFollowModel")}
									value={
										current()?.model
											? modelKey(
													current()!.model!.provider,
													current()!.model!.id,
												)
											: "follow"
									}
									disabled={disabled()}
									onPick={(model) =>
										save(connection, {
											model: model
												? { provider: model.provider, id: model.id }
												: null,
										})
									}
								/>
								<Switch
									testID={`settings-next-prompt-${connection.id}`}
									checked={current()?.enabled ?? false}
									disabled={disabled()}
									onChange={({ checked }) =>
										save(connection, { enabled: checked })
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
					})
				}
			</SettingsSection>
		</View>
	);
}
