import { mount, signal, Text } from "nsh";
import { Pilo, SessionFilesFixture } from "app/native";
import type { SessionHistoryResult } from "@shared/api/sessions-types";

const status = signal("loading settled history");

async function run() {
	const timestamp = "2025-01-02T03:04:05.000Z";
	const messages = [
		{ role: "user", content: "saved question" },
		{
			role: "assistant",
			content: [{ type: "text", text: "saved reply" }],
			stopReason: "stop",
		},
	];
	const jsonl = messages
		.map((message, index) =>
			JSON.stringify({
				type: "message",
				id: `message-${index}`,
				parentId: index === 0 ? null : `message-${index - 1}`,
				timestamp,
				message,
			}),
		)
		.join("\n");
	const fixture = new SessionFilesFixture(`${jsonl}\n`);
	const pilo = new Pilo(fixture.dataDir());
	const project = "session-files";
	const path = fixture.sessionPath();
	try {
		const full = (await pilo.loadHistory(
			project,
			path,
		)) as SessionHistoryResult;
		if (
			full.history.totalMessages !== 2 ||
			full.history.windowStartMessage !== 0 ||
			full.history.windowMessageCount !== 2 ||
			full.history.messageIndex?.length !== 2 ||
			!full.history.events.some(
				(event) =>
					event.type === "user_message_start" &&
					event.text === "saved question",
			) ||
			!full.fingerprint ||
			full.fingerprint.fileSize <= 0 ||
			!/^\d+$/.test(full.fingerprint.fileMtimeNs)
		) {
			throw new Error(`unexpected settled history: ${JSON.stringify(full)}`);
		}
		const window = (await pilo.loadHistory(project, path, {
			startMessage: 1,
			messageLimit: 1,
			includeMessageIndex: false,
			fingerprint: full.fingerprint,
		})) as SessionHistoryResult;
		if (
			window.history.totalMessages !== 2 ||
			window.history.windowStartMessage !== 1 ||
			window.history.windowMessageCount !== 1 ||
			window.history.messageIndex !== undefined ||
			!window.history.events.some(
				(event) =>
					event.type === "assistant_text_delta" &&
					event.delta === "saved reply",
			) ||
			window.history.events.some(
				(event) => event.type === "user_message_start",
			) ||
			window.fingerprint?.fileSize !== full.fingerprint.fileSize ||
			window.fingerprint.fileMtimeNs !== full.fingerprint.fileMtimeNs
		) {
			throw new Error(`unexpected history window: ${JSON.stringify(window)}`);
		}
		try {
			await pilo.loadHistory(
				project,
				path.replace(/fixture\.jsonl$/, "missing.jsonl"),
			);
		} catch (error) {
			if (error instanceof Error && error.message.endsWith("(os error 2)")) {
				return "settled history, window and missing session verified";
			}
			throw error;
		}
		throw new Error("a missing session unexpectedly returned history");
	} finally {
		await pilo.shutdown();
		fixture.dispose();
	}
}

mount(() => <Text>{status()}</Text>);
void run().then(status.set, (error: unknown) => status.set(String(error)));
