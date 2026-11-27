import { type Accessor, signal } from "nsh";

import type { HostClient } from "@shared/api/host-client";
import type { TerminalEvent } from "../client/host-api";

export type TerminalClient = Pick<
	HostClient,
	| "openTerminal"
	| "writeTerminal"
	| "resizeTerminal"
	| "closeTerminal"
	| "nextTerminalEvents"
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
	private polling = false;

	readonly tabs: Accessor<TerminalTab[]> = this.tabsSignal;
	/** The terminal shown in place of the chat; `null` shows the chat. */
	readonly activeId: Accessor<string | null> = this.activeSignal;
	readonly opening: Accessor<boolean> = () => this.openingSignal() !== null;

	constructor(private readonly client: TerminalClient) {}

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

	/** Opens a shell in the project in a new tab and shows it. */
	async open(projectId: string): Promise<void> {
		if (this.openingSignal()) return;
		const opening = {
			projectId,
			removed: false,
			events: new Map<string, PendingTerminal>(),
		};
		this.openingSignal.set(opening);
		void this.poll();
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
		if (this.activeSignal() === terminalId) {
			const siblings = this.projectTabs(tab.projectId);
			const index = siblings.findIndex(({ id }) => id === terminalId);
			const next = siblings[index + 1] ?? siblings[index - 1] ?? null;
			this.activeSignal.set(next?.id ?? null);
		}
		this.tabsSignal.set(tabs.filter(({ id }) => id !== terminalId));
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
		void this.client.writeTerminal(terminalId, data).catch((error: unknown) => {
			console.warn("Failed to write to the terminal", error);
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
