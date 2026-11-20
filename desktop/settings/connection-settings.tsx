import { type Signal, signal, View } from "nsh";

import type { Connection, PiModel } from "@/lib/api/pi-runtime-types";
import type { Project } from "@/lib/api/projects-types";
import type { NshPiloClient } from "../client/nsh-pilo-client";
import { t } from "../app/i18n";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Select, type SelectItem } from "../ui/select";

/** The connections the loaded projects use, in first-seen order. */
export function paneConnections(projects: readonly Project[]): Connection[] {
	const seen = new Map<string, Connection>();
	for (const project of projects) {
		if (!seen.has(project.connection.id))
			seen.set(project.connection.id, project.connection);
	}
	return [...seen.values()];
}

export function connectionLabel(connection: Connection): string {
	return connection.kind.type === "local" ? t("common.local") : connection.name;
}

/** `[provider, id]` as one string, the value the model Selects round-trip. */
export function modelKey(provider: string, id: string): string {
	return JSON.stringify([provider, id]);
}

type ModelListState = {
	models: PiModel[];
	loading: boolean;
	error: string | null;
};

/**
 * The Pi model catalog of each connection, loaded on first read and
 * refreshable through `loadConnectionModels`, as `useConnectionModels` was.
 */
export class ConnectionModelLists {
	private readonly entries = new Map<string, Signal<ModelListState>>();

	constructor(
		private readonly client: Pick<NshPiloClient, "loadConnectionModels">,
	) {}

	state(connectionId: string): Signal<ModelListState> {
		let entry = this.entries.get(connectionId);
		if (!entry) {
			entry = signal<ModelListState>({
				models: [],
				loading: true,
				error: null,
			});
			this.entries.set(connectionId, entry);
			this.refresh(connectionId);
		}
		return entry;
	}

	refresh(connectionId: string) {
		const entry = this.entries.get(connectionId);
		if (!entry) return;
		entry.set({ ...entry(), loading: true, error: null });
		this.client
			.loadConnectionModels(connectionId)
			.then((models) => entry.set({ models, loading: false, error: null }))
			.catch((error: unknown) =>
				entry.set({
					...entry(),
					loading: false,
					error: String(error),
				}),
			);
	}
}

/**
 * One connection's model Select plus its refresh button, the row shared by
 * the suggestion / enhancement / naming settings.
 */
export function ConnectionModelSelect(props: {
	testID?: string;
	connection: Connection;
	lists: ConnectionModelLists;
	/** Value and label of the "no model" option (follow / disabled). */
	noneValue: string;
	noneTitle: string;
	value: string;
	onPick: (model: PiModel | null) => void;
}) {
	const list = () => props.lists.state(props.connection.id)();
	return (
		<View class="flex-row items-center gap-2">
			<Select
				testID={props.testID}
				class="w-[280px]"
				items={[
					{ value: props.noneValue, title: props.noneTitle },
					...list().models.map((model) => ({
						value: modelKey(model.provider, model.id),
						title: `${model.name || model.id} · ${model.provider}`,
					})),
				]}
				value={props.value}
				onChange={({ value }) => {
					if (!value || value === props.noneValue) {
						props.onPick(null);
						return;
					}
					const model = list().models.find(
						(candidate) => modelKey(candidate.provider, candidate.id) === value,
					);
					if (model) props.onPick(model);
				}}
			/>
			<Button
				variant="ghost"
				size="icon"
				class="size-8"
				accessibilityLabel={t("settings.refreshModels")}
				onPress={() => props.lists.refresh(props.connection.id)}
			>
				<Icon
					name="RefreshCw"
					size={14}
					class={list().loading ? "animate-spin" : undefined}
				/>
			</Button>
		</View>
	);
}
