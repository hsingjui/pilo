import { expect, open, test } from "nsh/test";

test("Image accepts a Blob URL from native bytes, and refuses a local path no fs.read grant covers", async () => {
	const app = await open("./image-transport-fixture.tsx");
	expect(app.shows("text:native Uint8Array")).toBe(true);

	// The app declares its capabilities without `fs`, as the chat shows no
	// local file by path (the React app does not either): a native absolute
	// path is refused before it is read.
	await app.waitUntil(() =>
		app
			.texts()
			.some(
				(value) =>
					value.startsWith("path: ") && value.includes("is not granted"),
			),
	);

	// The headless host never decodes images, but can fail submitted sources.
	try {
		await app.failImages("data:image/png;nsh-key=*");
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!("code" in error) ||
			error.code !== "ERR_NSH_TEST_UNSUPPORTED"
		) {
			throw error;
		}
		await app.waitFor("text:bytes: 32x32");
		return;
	}
	await app.waitUntil(() =>
		app.texts().some((value) => value.startsWith("bytes: failed to load ")),
	);
});
