import { useEffect, useMemo, useSyncExternalStore } from "react";

import type { PiloClient } from "@/lib/api/pilo-client";
import type { Connection, PiModel } from "@/lib/api/pi-runtime";
import { userErrorMessage } from "@/lib/app-error";

type Snapshot = {
	models: readonly PiModel[];
	loading: boolean;
	error: string | null;
};

function createCatalog(client: PiloClient, connectionId: string) {
	let snapshot: Snapshot = { models: [], loading: false, error: null };
	let pending: Promise<void> | null = null;
	let requested = false;
	const listeners = new Set<() => void>();
	const publish = (next: Snapshot) => {
		snapshot = next;
		for (const listener of listeners) listener();
	};
	const load = (force = false): Promise<void> => {
		if (pending) return pending;
		if (requested && !force) return Promise.resolve();
		requested = true;
		publish({ ...snapshot, loading: true, error: null });
		pending = client
			.loadConnectionModels(connectionId)
			.then((models) => publish({ models, loading: false, error: null }))
			.catch((error: unknown) => {
				publish({
					...snapshot,
					loading: false,
					error: userErrorMessage(error),
				});
			})
			.finally(() => {
				pending = null;
			});
		return pending;
	};
	return {
		getSnapshot: () => snapshot,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		load,
	};
}

const catalogs = new WeakMap<
	PiloClient,
	Map<string, ReturnType<typeof createCatalog>>
>();

/** One shared catalog and in-flight read per transport and Connection configuration. */
export function useConnectionModels(
	client: PiloClient,
	connection: Connection,
) {
	const key = JSON.stringify([
		connection.id,
		connection.kind,
		connection.piRuntime,
		connection.piExecutable,
	]);
	const connectionId = connection.id;
	const catalog = useMemo(() => {
		let entries = catalogs.get(client);
		if (!entries) {
			entries = new Map();
			catalogs.set(client, entries);
		}
		let entry = entries.get(key);
		if (!entry) {
			entry = createCatalog(client, connectionId);
			entries.set(key, entry);
		}
		return entry;
	}, [client, key, connectionId]);
	const snapshot = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot);
	useEffect(() => {
		void catalog.load();
	}, [catalog]);
	return { ...snapshot, refresh: () => catalog.load(true) };
}
