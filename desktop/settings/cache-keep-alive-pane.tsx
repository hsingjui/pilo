import { type Accessor, signal, Text, View } from "nsh";

import { NumberInput } from "nsh/base";

import {
	type CacheKeepAliveSettings,
	defaultCacheKeepAliveSettings,
} from "@/lib/cache-keep-alive";
import type { AppState } from "../state/app-state";
import { t } from "../app/i18n";
import { Select, type SelectItem } from "../ui/select";
import { Switch } from "../ui/switch";
import {
	ConnectionModelLists,
	connectionLabel,
	modelKey,
	paneConnections,
} from "./connection-settings";
import { SettingsRow, SettingsSection } from "./layout";
import type { SettingsClient } from "./settings-dialog";

const TTL_MINUTES_RANGE = { min: 1, max: 1440 };
const DURATION_MINUTES_RANGE = { min: 1, max: 1440 };

/**
 * Cache keep-alive policies per connection: one row per saved model with its
 * TTL, its idle keep-alive duration and the switch; unconfigured models join
 * through the add Select.
 */
export function CacheKeepAlivePane(props: {
	state: Accessor<AppState>;
	client: SettingsClient;
}) {
	const lists = new ConnectionModelLists(props.client);
	const policies = signal<Record<string, CacheKeepAliveSettings[]>>({});
	const loaded = new Set<string>();
	const ensure = (connectionId: string) => {
		if (loaded.has(connectionId)) return;
		loaded.add(connectionId);
		props.client
			.loadCacheKeepAliveSettings(connectionId)
			.then((rows) => policies.set({ ...policies(), [connectionId]: rows }))
			.catch((error: unknown) => {
				console.error(String(error));
			});
	};
	const save = (settings: CacheKeepAliveSettings) => {
		props.client
			.saveCacheKeepAliveSettings(settings)
			.then((saved) => {
				const rows = (policies()[settings.connectionId] ?? []).filter(
					(row) =>
						row.provider !== saved.provider || row.modelId !== saved.modelId,
				);
				policies.set({
					...policies(),
					[settings.connectionId]: [...rows, saved],
				});
			})
			.catch((error: unknown) => {
				console.error(String(error));
			});
	};
	return (
		<View class="gap-3">
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
					const rows = () => policies()[connection.id] ?? [];
					const list = () => lists.state(connection.id)();
					const configured = () =>
						new Set(rows().map((row) => modelKey(row.provider, row.modelId)));
					const addItems = (): SelectItem[] =>
						list()
							.models.filter(
								(model) =>
									!configured().has(modelKey(model.provider, model.id)),
							)
							.map((model) => ({
								value: modelKey(model.provider, model.id),
								title: `${model.name || model.id} · ${model.provider}`,
							}));
					return (
						<SettingsSection
							title={connectionLabel(connection)}
							headerRight={
								<Select
									testID={`settings-keep-alive-add-${connection.id}`}
									class="w-[220px]"
									items={[
										{
											value: "add",
											title: t("settings.cacheKeepAliveAddModel"),
										},
										...addItems(),
									]}
									value="add"
									onChange={({ value }) => {
										if (!value || value === "add") return;
										const model = list().models.find(
											(candidate) =>
												modelKey(candidate.provider, candidate.id) === value,
										);
										if (!model) return;
										save({
											...(rows().find(
												(row) =>
													row.provider === model.provider &&
													row.modelId === model.id,
											) ??
												defaultCacheKeepAliveSettings(
													connection.id,
													model.provider,
													model.id,
												)),
											enabled: true,
										});
									}}
								/>
							}
						>
							{() => {
								const current = rows();
								if (current.length === 0)
									return (
										<View class="px-3 py-4">
											<Text class="text-sm text-muted-foreground">
												{() =>
													String(
														t(
															list().models.length
																? "settings.cacheKeepAliveEmpty"
																: "settings.cacheKeepAliveNoModels",
														),
													)
												}
											</Text>
										</View>
									);
								return current.map((row) => {
									const name =
										list().models.find(
											(model) =>
												model.provider === row.provider &&
												model.id === row.modelId,
										)?.name || row.modelId;
									return (
										<SettingsRow label={`${name} · ${row.provider}`}>
											<NumberInput
												testID={`settings-keep-alive-ttl-${connection.id}-${row.modelId}`}
												class="w-20"
												min={TTL_MINUTES_RANGE.min}
												max={TTL_MINUTES_RANGE.max}
												step={1}
												value={Math.round(row.cacheTtlSeconds / 60)}
												onChange={({ value }) => {
													if (value === null) return;
													save({
														...row,
														cacheTtlSeconds: value * 60,
													});
												}}
											/>
											<NumberInput
												testID={`settings-keep-alive-duration-${connection.id}-${row.modelId}`}
												class="w-20"
												min={DURATION_MINUTES_RANGE.min}
												max={DURATION_MINUTES_RANGE.max}
												step={1}
												value={Math.round(row.idleKeepAliveSeconds / 60)}
												onChange={({ value }) => {
													if (value === null) return;
													save({
														...row,
														idleKeepAliveSeconds: value * 60,
													});
												}}
											/>
											<Switch
												testID={`settings-keep-alive-${connection.id}-${row.modelId}`}
												checked={row.enabled}
												onChange={({ checked }) =>
													save({ ...row, enabled: checked })
												}
											/>
										</SettingsRow>
									);
								});
							}}
						</SettingsSection>
					);
				});
			}}
		</View>
	);
}
