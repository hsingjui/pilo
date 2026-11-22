import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 720 } as const;

function openLightbox(scenario = "project") {
	return open("./chat-image-lightbox-fixture.tsx", {
		...desktop,
		storage: { "fixture.scenario": scenario },
	});
}

test("pressing a project image opens the lightbox, zooms, saves, and closes", async () => {
	const app = await openLightbox("project");
	await app.waitFor("text:attempts:1");
	await app.waitFor("id:chat-markdown-image");
	await app.press("id:chat-markdown-image");
	await app.waitFor("id:lightbox-title");
	expect(app.shows("text:shot.png")).toBe(true);
	expect(app.shows("text:100%")).toBe(true);

	await app.press("id:lightbox-zoom-in");
	await app.waitFor("text:150%");
	await app.press("id:lightbox-zoom-reset");
	await app.waitFor("text:100%");

	await app.press("id:lightbox-save");
	await app.waitUntil(() =>
		app.texts().some((text) => text.startsWith("saved:shot.png:")),
	);

	await app.press("id:lightbox-close");
	await app.waitUntil(() => !app.shows("id:lightbox-title"));
});

test("pressing a failed project image retries loading and then opens the lightbox", async () => {
	const app = await openLightbox("retry");
	await app.waitFor("text:attempts:1");
	await app.waitFor("text:shot");
	await app.press("text:shot");
	await app.waitFor("text:attempts:2");
	await app.waitFor("id:chat-markdown-image");
	await app.press("id:chat-markdown-image");
	await app.waitFor("id:lightbox-title");
	expect(app.shows("text:shot.png")).toBe(true);
});

test("an external image shows the open original action and opens its URL", async () => {
	const app = await openLightbox("project");
	await app.waitFor("id:open-external");
	await app.press("id:open-external");
	await app.waitFor("id:lightbox-open-external");
	await app.press("id:lightbox-open-external");
	expect(app.openedUrls()).toEqual(["https://example.com/photo.png"]);
});

test("a save error shows a toast", async () => {
	const app = await openLightbox("saveerror");
	await app.waitFor("id:chat-markdown-image");
	await app.press("id:chat-markdown-image");
	await app.waitFor("id:lightbox-save");
	await app.press("id:lightbox-save");
	await app.waitFor("text:disk full");
});
