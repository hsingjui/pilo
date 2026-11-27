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
	try {
		await storage.setItem(key, legacy);
		await storage.removeItem(legacyKey);
	} catch {
		// Keep the legacy value usable even if storage refuses the migration.
	}
	return legacy;
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
		try {
			storage.setItem(key, legacy);
			storage.removeItem(legacyKey);
		} catch {
			// Keep the legacy value usable even if storage refuses the migration.
		}
		return legacy;
	}
	return null;
}
