import { mount, signal, Text, View } from "nsh";
import { ImageFixture, Pilo, SessionFilesFixture } from "app/native";

const status = signal("loading image bytes");
const projectId = "session-files";

function expectBytes(actual: Uint8Array, expected: Uint8Array) {
	if (
		!(actual instanceof Uint8Array) ||
		actual.length !== expected.length ||
		actual.some((byte, index) => byte !== expected[index])
	) {
		throw new Error("runtime did not return the original PNG bytes");
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
	const data = btoa(String.fromCharCode(...png));
	const jsonl =
		JSON.stringify({
			type: "message",
			id: "user-image",
			message: {
				role: "user",
				content: [
					{ type: "text", text: "Image attachment" },
					{ type: "image", mimeType: "image/png", data },
				],
			},
		}) + "\n";
	const fixture = new SessionFilesFixture(jsonl);
	const pilo = new Pilo(fixture.dataDir());
	const session = fixture.sessionPath();
	try {
		expectBytes(await pilo.readProjectImage(projectId, "fixture.png"), png);
		expectBytes(
			await pilo.readHistoryImage(projectId, session, "user-image:1"),
			png,
		);
		await expectError(
			pilo.readProjectImage(projectId, "../fixture.png"),
			"image path must be relative",
		);
		await expectError(
			pilo.readHistoryImage(projectId, session, "missing:0"),
			"image 'missing:0' was not found",
		);
		await expectError(
			pilo.readHistoryImage(projectId, session, "user-image:1", {
				fileSize: jsonl.length,
				fileMtimeNs: "bad",
			}),
			"invalid expected session mtime",
		);
	} finally {
		await pilo.shutdown();
		fixture.dispose();
	}
	await expectError(
		pilo.readProjectImage(projectId, "fixture.png"),
		"Pilo runtime has been shut down",
	);
	await expectError(
		pilo.readHistoryImage(projectId, session, "user-image:1"),
		"Pilo runtime has been shut down",
	);
	status.set("project and transcript image bytes verified");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));
