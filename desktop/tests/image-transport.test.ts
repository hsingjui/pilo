import { expect, open, test } from "nsh/test";

test("Image accepts a Blob URL from native bytes and a native absolute path", async () => {
	const app = await open("./image-transport-fixture.tsx");
	expect(app.shows("text:native Uint8Array")).toBe(true);

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
		await app.waitFor("text:path: 32x32");
		return;
	}

	await app.failImages("*/src-tauri/icons/32x32.png");
	expect(
		app.texts().some((value) => value.startsWith("bytes: failed to load ")),
	).toBe(true);
	expect(
		app.texts().some((value) => value.startsWith("path: failed to load ")),
	).toBe(true);
});
