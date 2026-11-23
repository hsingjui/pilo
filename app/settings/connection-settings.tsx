import { effect, type Signal, signal, View } from "nsh";

import type { ConnectionTestResult } from "@shared/api/connections-types";
import type {
	Connection,
	PiModel,
	PiloRuntimeEvent,
} from "@shared/api/pi-runtime-types";
import { userErrorMessage } from "@shared/app-error";
import { type AppToasts, showToast } from "../shell/app-toasts";
import type { NshPiloClient } from "../client/nsh-pilo-client";
import { t } from "../shell/i18n";
import { Icon } from "../ui/icon";
import { Select } from "../ui/select";
import { SettingsIconButton } from "./layout";

export type ConnectionCatalogClient = Pick<
	NshPiloClient,
	"getLocalConnection" | "listWslConnections" | "listSshConnections"
>;

/**
 * Local plus every configured WSL and SSH connection, in the order
 * `listConnectionCatalog` returns — every configured connection, not only the
 * ones a loaded project uses. Local falls back to the default entry on
 * failure; a WSL or SSH failure omits that group, as `Promise.allSettled`
 * did.
 */
export async function paneConnectionCatalog(
	client: ConnectionCatalogClient,
): Promise<Connection[]> {
	const [local, wsl, ssh] = await Promise.allSettled([
		client.getLocalConnection(),
		client.listWslConnections(),
		client.listSshConnections(),
	]);
	const connections: Connection[] = [
		local.status === "fulfilled"
			? local.value
			: { id: "local", name: "Local", kind: { type: "local" } },
	];
	if (wsl.status === "fulfilled")
		connections.push(...wsl.value.map((info) => info.connection));
	if (ssh.status === "fulfilled")
		connections.push(...ssh.value.map((info) => info.connection));
	return connections;
}

/**
 * Subscribe a settings pane to runtime events for its lifetime, handling
 * unmount before the subscription settles and ignoring transport errors.
 */
export function subscribeSettingsEvents(
	client: Pick<NshPiloClient, "connectEvents">,
	onEvent: (event: PiloRuntimeEvent) => void,
): void {
	effect(() => {
		let stop: (() => void) | undefined;
		let disposed = false;
		void client
			.connectEvents({
				onMessage(message) {
					if (message.type !== "events") return;
					for (const event of message.events) onEvent(event);
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
}

export function showConnectionTestToast(
	toasts: AppToasts | null,
	name: string,
	outcome:
		| { ok: true; result: ConnectionTestResult }
		| { ok: false; error: unknown },
): void {
	if (outcome.ok) {
		showToast(toasts, {
			variant: "success",
			title: t("connection.available", { name }),
			description: `pilo-server ${outcome.result.serverVersion} · protocol ${outcome.result.protocolVersion}`,
		});
		return;
	}
	showToast(toasts, {
		variant: "error",
		title: t("connection.connectionFailed", { name }),
		description: userErrorMessage(outcome.error),
	});
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
			.then((models) =>
				entry.set({
					models: uniqueModels(models),
					loading: false,
					error: null,
				}),
			)
			.catch((error: unknown) =>
				entry.set({
					...entry(),
					loading: false,
					error: userErrorMessage(error),
				}),
			);
	}
}

/**
 * One connection's model Select plus its refresh button, the row shared by
 * the suggestion / enhancement / naming settings. A saved value missing from
 * the catalog shows `settings.modelUnavailable`, as the React SelectValue
 * placeholder did; the refresh button is disabled while the catalog loads.
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
	disabled?: boolean;
}) {
	const list = () => props.lists.state(props.connection.id)();
	const items = () => [
		{ value: props.noneValue, title: props.noneTitle },
		...list().models.map((model) => ({
			value: modelKey(model.provider, model.id),
			title: `${model.name || model.id} · ${model.provider}`,
		})),
	];
	const unavailable = () =>
		props.value !== props.noneValue &&
		!items().some((item) => item.value === props.value);
	return (
		<View class="w-80 min-w-0 max-w-full flex-row items-center gap-2">
			<Select
				testID={props.testID}
				size="sm"
				class="flex-1"
				items={items()}
				value={unavailable() ? null : props.value}
				placeholder={
					unavailable() ? t("settings.modelUnavailable") : props.noneTitle
				}
				disabled={props.disabled}
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
			<RefreshModelsButton
				loading={list().loading}
				onPress={() => props.lists.refresh(props.connection.id)}
			/>
		</View>
	);
}

/** The compact ghost button that reloads a connection's model catalog, spinning while it loads. */
export function RefreshModelsButton(props: {
	loading: boolean;
	onPress: () => void;
}) {
	return (
		<SettingsIconButton
			disabled={props.loading}
			accessibilityLabel={t("settings.refreshModels")}
			onPress={props.onPress}
		>
			<Icon
				name="RefreshCw"
				size={14}
				class={props.loading ? "animate-spin" : undefined}
			/>
		</SettingsIconButton>
	);
}

/** Models deduped by `[provider, id]`, as the React model Selects did. */
export function uniqueModels(models: readonly PiModel[]): PiModel[] {
	return [
		...new Map(models.map((m) => [modelKey(m.provider, m.id), m])).values(),
	];
}
