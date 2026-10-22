import type { PiloPreferences } from "./preferences-provider";
import type { AppLocale } from "@/i18n/locale";

export type HostPreferenceValues = PiloPreferences & { locale: AppLocale };
export type PreferencesSnapshot = {
	revision: number;
	values: HostPreferenceValues;
};
export type PreferencePatch = Partial<
	Omit<HostPreferenceValues, "keyboardShortcuts">
> & { keyboardShortcuts?: Partial<PiloPreferences["keyboardShortcuts"]> };

export type PreferencesTransport = {
	load: () => Promise<PreferencesSnapshot>;
	patch: (patch: PreferencePatch) => Promise<PreferencesSnapshot>;
};

let binding = 0;
let transport: PreferencesTransport | null = null;
let writes: Promise<unknown> = Promise.resolve();
let ready: Promise<unknown> = Promise.resolve();
const listeners = new Set<
	(snapshot: PreferencesSnapshot, binding: number) => void
>();

export function bindHostPreferences(
	next: PreferencesTransport,
	initialize?: () => Promise<PreferencesSnapshot>,
) {
	const current = ++binding;
	transport = next;
	writes = Promise.resolve();
	ready = (initialize ? initialize() : next.load()).then((snapshot) => {
		if (binding === current) publishHostPreferences(snapshot);
	});
	return {
		ready,
		dispose: () => {
			if (binding === current) {
				binding++;
				transport = null;
			}
		},
	};
}

export function publishHostPreferences(snapshot: PreferencesSnapshot) {
	for (const listener of listeners) listener(snapshot, binding);
}

export function subscribeHostPreferences(
	listener: (snapshot: PreferencesSnapshot, binding: number) => void,
) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function writeHostPreferences(patch: PreferencePatch): Promise<void> {
	const target = transport;
	const current = binding;
	const initialized = ready;
	if (!target)
		return Promise.reject(new Error("Pilo preferences are not connected"));
	const request = writes
		.catch(() => {})
		.then(async () => {
			await initialized;
			if (current !== binding)
				throw new Error("Pilo preferences connection changed");
			const snapshot = await target.patch(patch);
			if (current === binding) publishHostPreferences(snapshot);
		});
	writes = request;
	return request;
}

export async function refreshHostPreferences() {
	const current = binding;
	if (!transport) return;
	const snapshot = await transport.load();
	if (current === binding) {
		// A successful reload recovers a failed initialization, not its failed writes.
		ready = Promise.resolve();
		publishHostPreferences(snapshot);
	}
}
