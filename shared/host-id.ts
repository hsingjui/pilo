export const LOCAL_HOST_ID = "local";

export function hostStorageKey(hostId: string, key: string): string {
	return `${key}@${hostId}`;
}

/** Insert the Host before the delimiter so the record suffix still follows a scannable prefix. */
export function hostStoragePrefix(hostId: string, prefix: string): string {
	return `${hostStorageKey(hostId, prefix.replace(/:$/, ""))}:`;
}

export type KeyValueStorage = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
};

type AsyncKeyValueStorage = {
	[Method in keyof KeyValueStorage]: (
		...args: Parameters<KeyValueStorage[Method]>
	) => Promise<ReturnType<KeyValueStorage[Method]>>;
};

export async function readMigratedStorage(
	storage: AsyncKeyValueStorage,
	key: string,
	legacyKey?: string,
): Promise<string | null> {
	const current = await storage.getItem(key);
	if (current !== null || legacyKey === undefined) return current;
	const legacy = await storage.getItem(legacyKey);
	if (legacy === null) return null;
	let value = legacy;
	try {
		const latest = await storage.getItem(key);
		if (latest !== null) return latest;
		await storage.setItem(key, legacy);
		const saved = await storage.getItem(key);
		if (saved === null) return value;
		value = saved;
		await storage.removeItem(legacyKey);
	} catch {
		// Keep the legacy value usable even if storage refuses the migration.
	}
	return value;
}

export function readMigratedStorageSync(
	storage: KeyValueStorage,
	key: string,
	...legacyKeys: string[]
): string | null {
	const current = storage.getItem(key);
	if (current !== null) return current;
	for (const legacyKey of legacyKeys) {
		const legacy = storage.getItem(legacyKey);
		if (legacy === null) continue;
		let value = legacy;
		try {
			const latest = storage.getItem(key);
			if (latest !== null) return latest;
			storage.setItem(key, legacy);
			const saved = storage.getItem(key);
			if (saved === null) return value;
			value = saved;
			storage.removeItem(legacyKey);
		} catch {
			// Keep the legacy value usable even if storage refuses the migration.
		}
		return value;
	}
	return null;
}
