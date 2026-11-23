import { expect, open, test } from "nsh/test";

const desktop = {
	platform: "macos",
	width: 1100,
	height: 720,
	locale: "en-US",
} as const;

function openChat(scenario: string) {
	return open("./chat-markdown-fixture.tsx", {
		...desktop,
		storage: { "fixture.scenario": scenario },
	});
}

test("a reply renders its Markdown: headings, styles, lists, table, quote, code", async () => {
	const app = await openChat("reply");
	await app.waitFor("text:Reply heading");
	expect(app.shows("text:A paragraph with bold words and inline code.")).toBe(
		true,
	);
	expect(app.shows("text:name")).toBe(true);
	expect(app.shows("text:value")).toBe(true);
	expect(app.shows("text:a quote")).toBe(true);
	expect(app.shows("text:const answer: number = 42;")).toBe(true);
	expect(app.shows("text:Below the image")).toBe(true);
});

test("a reply still coming renders the Markdown it has so far", async () => {
	const app = await openChat("streaming");
	await app.waitFor("text:Reply heading");
	expect(app.shows("text:Below the image")).toBe(true);
});

test("the default body also renders Markdown", async () => {
	const app = await openChat("plain");
	await app.waitFor("text:Reply heading");
	expect(app.shows("text:const answer: number = 42;")).toBe(true);
});

test("a press on a project file link reports the resolved file URL", async () => {
	const app = await openChat("reply");
	await app.waitFor("text:Reply heading");
	await app.press("text:the project file");
	await app.waitFor("text:file:file:///work/demo/src/main.ts#10");
	expect(app.openedUrls()).toEqual([]);
});

test("a press on a web link opens it outside the app", async () => {
	const app = await openChat("reply");
	await app.waitFor("text:Reply heading");
	await app.press("text:the site");
	expect(app.openedUrls()).toEqual(["https://example.com/docs"]);
});

test("a project-relative image is read through the client and shown", async () => {
	const app = await openChat("reply");
	await app.waitFor("text:Above the image");
	await app.waitFor("text:image:read shot.png");
	expect(app.shows("text:Below the image")).toBe(true);
});

test("a project image that cannot be read shows its fallback", async () => {
	const app = await openChat("readerror");
	await app.waitFor("text:Above the image");
	await app.waitFor("text:image:failed");
	await app.waitFor("text:shot");
	expect(app.shows("text:Below the image")).toBe(true);
});

test("a code block's copy button copies the code and shows a toast", async () => {
	const app = await openChat("reply");
	await app.waitFor("text:const answer: number = 42;");
	await app.hover("text:const answer: number = 42;");
	await app.press("label:Copy code");
	expect(app.clipboard()).toContain("const answer: number = 42;");
	await app.waitFor("text:Copied");
});
