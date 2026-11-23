import { mount, signal, Text, View } from "nsh";
import { ImageFixture, Pilo, SessionFilesFixture } from "app/native";

import { NshPiloClient } from "../client/nsh-pilo-client";

const projectId = "session-files";
const status = signal("reading image bytes through the client");

function assertBytes(actual: Uint8Array, expected: Uint8Array, what: string) {
	if (
		// The shared `PiloClient` type promises bytes a Blob can take.
		!(actual.buffer instanceof ArrayBuffer) ||
		actual.length !== expected.length ||
		actual.some((byte, index) => byte !== expected[index])
	) {
		throw new Error(`${what} did not return the original PNG bytes`);
	}
}

async function expectError(promise: Promise<unknown>, message: string) {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Error && error.message.includes(message)) return;
		throw error;
	}
	throw new Error(`expected rejection: ${message}`);
}

async function run() {
	const png = ImageFixture.bytes();
	const jsonl = `${JSON.stringify({
		type: "message",
		id: "user-image",
		message: {
			role: "user",
			content: [
				{ type: "text", text: "Image attachment" },
				{
					type: "image",
					mimeType: "image/png",
					data: btoa(String.fromCharCode(...png)),
				},
			],
		},
	})}\n`;
	const fixture = new SessionFilesFixture(jsonl);
	const client = new NshPiloClient(new Pilo(fixture.dataDir()));
	const sessionPath = fixture.sessionPath();
	try {
		assertBytes(
			await client.readProjectImage(projectId, "fixture.png"),
			png,
			"the project image",
		);
		assertBytes(
			await client.readHistoryImage(projectId, sessionPath, "user-image:1"),
			png,
			"the session image",
		);
		await expectError(
			client.readProjectImage(projectId, "../fixture.png"),
			"image path must be relative",
		);
		await expectError(
			client.readHistoryImage(projectId, sessionPath, "missing:0"),
			"image 'missing:0' was not found",
		);
		// The fingerprint reaches the runtime, which checks it.
		await expectError(
			client.readHistoryImage(projectId, sessionPath, "user-image:1", {
				fileSize: jsonl.length,
				fileMtimeNs: "bad",
			}),
			"invalid expected session mtime",
		);
	} finally {
		await client.shutdown();
		fixture.dispose();
	}
	await expectError(
		client.readProjectImage(projectId, "fixture.png"),
		"Pilo runtime has been shut down",
	);
	status.set("client project and session image bytes verified");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
