import { expect, test } from "nsh/test";

import {
	hostStorageKey,
	hostStoragePrefix,
	LOCAL_HOST_ID,
	readMigratedStorage,
	readMigratedStorageSync,
} from "@shared/host-id";

for (const mode of ["sync", "async"] as const) {
	test(`${mode} Host storage migration preserves new and legacy values`, async () => {
		const entries = new Map<string, string>();
		const storage = {
			getItem: (key: string) => entries.get(key) ?? null,
			setItem: (key: string, value: string) => {
				if (value === "blocked") throw new Error("storage is full");
				entries.set(key, value);
			},
			removeItem: (key: string) => void entries.delete(key),
		};
		const key = hostStorageKey(LOCAL_HOST_ID, "prefs");
		const read = () =>
			mode === "sync"
				? readMigratedStorageSync(storage, key, "prefs")
				: readMigratedStorage(
						{
							getItem: async (name) => storage.getItem(name),
							setItem: async (name, value) => storage.setItem(name, value),
							removeItem: async (name) => storage.removeItem(name),
						},
						key,
						"prefs",
					);
		expect(key).toBe("prefs@local");
		expect(hostStoragePrefix(LOCAL_HOST_ID, "draft:")).toBe("draft@local:");
		expect(await read()).toBe(null);
		entries.set("prefs", "blocked");
		expect(await read()).toBe("blocked");
		expect(entries.get("prefs")).toBe("blocked");
		expect(entries.has(key)).toBe(false);
		entries.set("prefs", "old");
		expect(await read()).toBe("old");
		expect(entries.has("prefs")).toBe(false);
		expect(entries.get(key)).toBe("old");
		entries.set(key, "");
		entries.set("prefs", "must not win");
		expect(await read()).toBe("");
		expect(entries.get("prefs")).toBe("must not win");
	});

	test(`${mode} Host migration preserves a concurrent namespaced write`, async () => {
		const key = "prefs@local";
		const entries = new Map([["prefs", "old"]]);
		let writes = 0;
		const storage = {
			getItem(name: string) {
				const value = entries.get(name) ?? null;
				if (name === "prefs") entries.set(key, "");
				return value;
			},
			setItem(name: string, value: string) {
				writes += 1;
				entries.set(name, value);
			},
			removeItem: (name: string) => void entries.delete(name),
		};
		const value =
			mode === "sync"
				? readMigratedStorageSync(storage, key, "prefs")
				: await readMigratedStorage(
						{
							getItem: async (name) => storage.getItem(name),
							setItem: async (name, value) => storage.setItem(name, value),
							removeItem: async (name) => storage.removeItem(name),
						},
						key,
						"prefs",
					);
		expect(value).toBe("");
		expect(entries.get(key)).toBe("");
		expect(writes).toBe(0);
	});
}
