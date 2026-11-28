import { type Accessor, signal } from "nsh";

import type { HostClient } from "@shared/api/host-client";
import { HostApiError, type TerminalEvent } from "@shared/api/host-methods";

export type TerminalClient = Pick<
	HostClient,
	| "openTerminal"
	| "writeTerminal"
	| "resizeTerminal"
	| "closeTerminal"
	| "nextTerminalEvents"
> &
	Partial<
		Pick<
			HostClient,
			| "reconnectsEvents"
			| "eventStream"
			| "hasMethod"
			| "subscribeTerminal"
			| "attachTerminal"
			| "snapshotTerminal"
		>
	>;

/** A terminal open in a workspace tab beside its project's chat. */
export type TerminalTab = {
	id: string;
	projectId: string;
	/** The project's name, as the runtime titles the terminal. */
	title: string;
	/** Its place among the project's terminals, from 1. */
	number: number;
	/** The shell has exited; the tab stays until it is closed. */
	exited: boolean;
};

/** Where a terminal's page takes what the shell reports. */
export type TerminalSink = {
	/** Output bytes, base64. */
	output(data: string): void;
	reset?(): void;
	outputTruncated?(): void;
	exit(): void;
	error(message: string): void;
};

/** The first size a shell opens with, before its page measures itself. */
const INITIAL_COLS = 80;
const INITIAL_ROWS = 24;
const EVENT_BATCH_SIZE = 256;
// Per unattached terminal, including output that arrives before open resolves.
const MAX_PENDING_OUTPUT_BYTES = 4 * 1024 * 1024;

type PendingTerminal = {
	output: string[];
	bytes: number;
	truncated: boolean;
	end?: Exclude<TerminalEvent, { type: "output" }>;
};

type RemoteTerminal = {
	unsubscribe: () => void;
	offset: number;
	recovery?: { events: TerminalEvent[]; bytes: number };
};

/**
 * The project terminals the app holds: their tabs, which one is in front of
 * the chat, and the events the runtime reports for them, kept for a page
 * that has not attached yet.
 */
export class TerminalStore {
	private readonly tabsSignal = signal<TerminalTab[]>([]);
	private readonly activeSignal = signal<string | null>(null);
	private readonly openingSignal = signal<{
		projectId: string;
		removed: boolean;
		events: Map<string, PendingTerminal>;
	} | null>(null);
	private readonly sinks = new Map<string, TerminalSink>();
	private readonly pending = new Map<string, PendingTerminal>();
	private readonly writes = new Map<string, Promise<void>>();
	private polling = false;
	private readonly remote = new Map<string, RemoteTerminal>();
	private readonly disconnectRemote?: () => void;

	readonly tabs: Accessor<TerminalTab[]> = this.tabsSignal;
	/** The terminal shown in place of the chat; `null` shows the chat. */
	readonly activeId: Accessor<string | null> = this.activeSignal;
	readonly opening: Accessor<boolean> = () => this.openingSignal() !== null;

	constructor(private readonly client: TerminalClient) {
		if (client.reconnectsEvents) {
			this.disconnectRemote = client
				.eventStream?.()
				.onConnectionState?.((state) => {
					if (state !== "connected") {
						for (const terminal of this.remote.values())
							terminal.recovery = undefined;
					}
				});
		}
	}

	/** The project's terminal tabs, in the order they were opened. */
	projectTabs(projectId: string | null | undefined) {
		return this.tabsSignal().filter((tab) => tab.projectId === projectId);
	}

	/** The terminal in front of the project's chat, if any. */
	activeTab(projectId: string | null | undefined) {
		const id = this.activeSignal();
		return (
			this.tabsSignal().find(
				(tab) => tab.id === id && tab.projectId === projectId,
			) ?? null
		);
	}

	async selectOrOpen(projectId: string): Promise<void> {
		const existing = this.projectTabs(projectId).find((tab) => !tab.exited);
		if (existing) this.select(existing.id);
		else await this.open(projectId);
	}

	/** Opens a shell in the project in a new tab and shows it. */
	async open(projectId: string): Promise<void> {
		if (this.openingSignal()) return;
		const opening = {
			projectId,
			removed: false,
			events: new Map<string, PendingTerminal>(),
		};
		this.openingSignal.set(opening);
		if (!this.client.reconnectsEvents) void this.poll();
		try {
			const info = await this.client.openTerminal(
				projectId,
				INITIAL_COLS,
				INITIAL_ROWS,
			);
			if (opening.removed) return;
			const kept = opening.events.get(info.id);
			if (kept) this.pending.set(info.id, kept);
			const number =
				Math.max(0, ...this.projectTabs(projectId).map((tab) => tab.number)) +
				1;
			this.tabsSignal.update((tabs) => [
				...tabs,
				{
					id: info.id,
					projectId: info.projectId,
					title: info.title,
					number,
					exited: kept?.end !== undefined,
				},
			]);
			this.activeSignal.set(info.id);
			this.subscribeRemote(info.id);
		} finally {
			this.openingSignal.set(null);
		}
	}

	/** Drops tabs for removed projects; the Host closes their shells. */
	reconcileProjects(projectIds: ReadonlySet<string>) {
		const opening = this.openingSignal();
		if (opening && !projectIds.has(opening.projectId)) opening.removed = true;
		const tabs = this.tabsSignal();
		const remaining = tabs.filter((tab) => {
			if (projectIds.has(tab.projectId)) return true;
			this.sinks.delete(tab.id);
			this.pending.delete(tab.id);
			this.removeRemote(tab.id);
			if (this.activeSignal() === tab.id) this.activeSignal.set(null);
			return false;
		});
		if (remaining.length !== tabs.length) this.tabsSignal.set(remaining);
	}

	/** Shows the terminal, or the chat with `null`. */
	select(terminalId: string | null) {
		this.activeSignal.set(terminalId);
	}

	/** Closes the tab and its shell; the next tab of its project takes its place. */
	close(terminalId: string) {
		const tabs = this.tabsSignal();
		const tab = tabs.find(({ id }) => id === terminalId);
		if (!tab) return;
		void this.client.closeTerminal(terminalId).catch((error: unknown) => {
			console.warn("Failed to close the terminal", error);
		});
		this.sinks.delete(terminalId);
		this.pending.delete(terminalId);
		this.removeRemote(terminalId);
		if (this.activeSignal() === terminalId) {
			const siblings = this.projectTabs(tab.projectId);
			const index = siblings.findIndex(({ id }) => id === terminalId);
			const next = siblings[index + 1] ?? siblings[index - 1] ?? null;
			this.activeSignal.set(next?.id ?? null);
		}
		this.tabsSignal.set(tabs.filter(({ id }) => id !== terminalId));
	}

	dispose() {
		this.disconnectRemote?.();
		for (const id of this.remote.keys()) this.removeRemote(id);
	}

	private removeRemote(id: string) {
		this.remote.get(id)?.unsubscribe();
		this.remote.delete(id);
	}

	private subscribeRemote(id: string) {
		if (!this.client.reconnectsEvents || !this.client.subscribeTerminal) return;
		const terminal: RemoteTerminal = {
			offset: 0,
			unsubscribe: () => {},
		};
		this.remote.set(id, terminal);
		terminal.unsubscribe = this.client.subscribeTerminal(
			id,
			(event) => {
				const current = this.remote.get(id);
				if (!current) return;
				const pending = current.recovery;
				if (!pending) {
					this.deliverRemote(current, event);
					return;
				}
				if (
					event.type !== "output" ||
					pending.bytes < MAX_PENDING_OUTPUT_BYTES
				) {
					pending.events.push(event);
					if (event.type === "output") pending.bytes += outputBytes(event.data);
				}
			},
			(ack) => {
				if (this.remote.get(id) !== terminal) return;
				if (ack instanceof HostApiError) this.handleRecoveryError(id, ack);
				else void this.recover(id, terminal);
			},
		);
	}

	private handleRecoveryError(id: string, error: unknown) {
		if (
			error instanceof HostApiError &&
			(error.code === "not_found" || error.code === "forbidden")
		) {
			this.dispatch({ type: "error", terminalId: id, message: error.message });
		}
	}

	private async recover(id: string, terminal: RemoteTerminal) {
		if (
			terminal.recovery ||
			!this.client.attachTerminal ||
			!this.client.snapshotTerminal ||
			this.client.hasMethod?.("terminal.attach") === false ||
			this.client.hasMethod?.("terminal.snapshot") === false ||
			this.tabsSignal().find((tab) => tab.id === id)?.exited
		)
			return;
		const recovery = { events: [] as TerminalEvent[], bytes: 0 };
		terminal.recovery = recovery;
		const current = () =>
			this.remote.get(id) === terminal && terminal.recovery === recovery;
		try {
			await this.client.attachTerminal(id);
			if (!current()) return;
			const snapshot = await this.client.snapshotTerminal(id);
			if (!current()) return;
			if (snapshot.endOffset !== undefined) {
				this.deliverRemote(terminal, {
					type: "output",
					terminalId: id,
					data: snapshot.data,
					startOffset: snapshot.endOffset - base64Length(snapshot.data),
				});
			} else {
				this.pending.delete(id);
				this.sinks.get(id)?.reset?.();
				this.dispatch({ type: "output", terminalId: id, data: snapshot.data });
			}
		} catch (error) {
			if (current()) this.handleRecoveryError(id, error);
		} finally {
			if (current()) {
				terminal.recovery = undefined;
				for (const event of recovery.events)
					this.deliverRemote(terminal, event);
			}
		}
	}

	private deliverRemote(terminal: RemoteTerminal, event: TerminalEvent) {
		if (event.type === "output" && event.startOffset !== undefined) {
			const end = event.startOffset + base64Length(event.data);
			if (end <= terminal.offset) return;
			if (event.startOffset > terminal.offset) {
				this.sinks.get(event.terminalId)?.outputTruncated?.();
			}
			const alreadyShown = terminal.offset - event.startOffset;
			terminal.offset = end;
			if (alreadyShown > 0) {
				event = { ...event, data: btoa(atob(event.data).slice(alreadyShown)) };
			}
		}
		this.dispatch(event);
	}

	/** Routes the terminal's events to its page, those kept for it first. */
	attach(terminalId: string, sink: TerminalSink): () => void {
		this.sinks.set(terminalId, sink);
		const kept = this.pending.get(terminalId);
		this.pending.delete(terminalId);
		if (kept) {
			if (kept.truncated) sink.outputTruncated?.();
			for (const data of kept.output) sink.output(data);
			if (kept.end) deliver(sink, kept.end);
		}
		return () => {
			if (this.sinks.get(terminalId) === sink) this.sinks.delete(terminalId);
		};
	}

	write(terminalId: string, data: Uint8Array) {
		const tab = this.tabsSignal().find(({ id }) => id === terminalId);
		if (!tab || tab.exited) return;
		// Keystrokes may travel as separate HTTP calls; keep them in order.
		const previous = this.writes.get(terminalId);
		const send = () => this.client.writeTerminal(terminalId, data);
		const queued = (previous ? previous.then(send) : send()).catch(
			(error: unknown) => {
				console.warn("Failed to write to the terminal", error);
			},
		);
		this.writes.set(terminalId, queued);
		void queued.then(() => {
			if (this.writes.get(terminalId) === queued)
				this.writes.delete(terminalId);
		});
	}

	resize(terminalId: string, cols: number, rows: number) {
		const tab = this.tabsSignal().find(({ id }) => id === terminalId);
		if (!tab || tab.exited) return;
		void this.client
			.resizeTerminal(terminalId, cols, rows)
			.catch((error: unknown) => {
				console.warn("Failed to resize the terminal", error);
			});
	}

	/** Keeps one native wait for terminal events in flight. */
	private async poll() {
		if (this.polling) return;
		this.polling = true;
		try {
			for (;;) {
				// oxlint-disable-next-line no-await-in-loop -- Events are read in order, one batch at a time.
				const events = await this.client.nextTerminalEvents(EVENT_BATCH_SIZE);
				if (events.length === 0) break;
				for (const event of events) this.dispatch(event);
			}
		} catch (error) {
			console.error("Terminal event polling failed", error);
		}
		this.polling = false;
	}

	private dispatch(event: TerminalEvent) {
		const known = this.tabsSignal().some(({ id }) => id === event.terminalId);
		if (known && (event.type === "exit" || event.type === "error")) {
			this.tabsSignal.update((tabs) =>
				tabs.map((tab) =>
					tab.id === event.terminalId ? { ...tab, exited: true } : tab,
				),
			);
		}
		const sink = this.sinks.get(event.terminalId);
		if (sink) {
			deliver(sink, event);
			return;
		}
		// Keep early events only until `open` identifies the new terminal.
		const opening = this.openingSignal();
		const queue = known
			? this.pending
			: opening?.removed
				? null
				: opening?.events;
		if (!queue) return;
		let kept = queue.get(event.terminalId);
		if (!kept) {
			kept = { output: [], bytes: 0, truncated: false };
			queue.set(event.terminalId, kept);
		}
		if (event.type !== "output") {
			kept.end = event;
			return;
		}
		if (!event.data) return;
		const added = outputBytes(event.data);
		kept.output.push(event.data);
		kept.bytes += added;
		if (kept.bytes <= MAX_PENDING_OUTPUT_BYTES) return;
		// Drop oldest chunks in batches to avoid shifting the queue on every write.
		const target = Math.max(
			MAX_PENDING_OUTPUT_BYTES / 2,
			Math.min(added, MAX_PENDING_OUTPUT_BYTES),
		);
		let remove = 0;
		while (kept.bytes > target) {
			kept.bytes -= outputBytes(kept.output[remove++]);
		}
		kept.output.splice(0, remove);
		kept.truncated = true;
	}
}

function outputBytes(data: string) {
	// Charge the retained base64 string (up to two bytes per code unit) and queue overhead.
	return data.length * 2 + 64;
}

function base64Length(data: string) {
	return (
		Math.floor((data.length * 3) / 4) -
		(data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0)
	);
}

function deliver(sink: TerminalSink, event: TerminalEvent) {
	switch (event.type) {
		case "output":
			sink.output(event.data);
			return;
		case "exit":
			sink.exit();
			return;
		case "error":
			sink.error(event.message);
			return;
	}
}
