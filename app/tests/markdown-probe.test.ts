import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 720 } as const;

function openProbe(rows = 10, blocks = 60) {
	return open("./markdown-probe-fixture.tsx", {
		...desktop,
		storage: {
			"fixture.rows": String(rows),
			"fixture.blocks": String(blocks),
		},
		network: {
			"GET https://example.com/pic.png": {
				status: 200,
				body: "tiny png",
			},
		},
	});
}

test("a reply renders every markdown part", async () => {
	const app = await openProbe(1, 60);
	await app.waitFor("text:Heading 0");
	const all = () => app.texts().join("\n");
	expect(all()).toContain("Paragraph 1");
	expect(all()).toContain("item 2a");
	expect(all()).toContain("first 3");
	expect(all()).toContain("value4");
	expect(all()).toContain("a5");
	expect(all()).toContain("quote 6");
	expect(all()).toContain("task 9 done");
});

test("a streamed reply shows syntax as it closes, not as literal marks", async () => {
	const app = await openProbe(0);
	await app.waitFor("text:streamed 0");
	await app.press("id:stream");
	await app.waitFor("text:streamed 1");
	// "**bo" is mid-formation: it reads as bold text, never as asterisks.
	expect(app.texts().join("\n")).not.toContain("**bo");
	await app.press("id:stream");
	await app.waitFor("text:streamed 2");
	expect(app.texts().join("\n")).toContain("bold phrase");
	for (let index = 0; index < 8; index++) await app.press("id:stream");
	await app.waitFor("text:streamed 10");
	expect(app.texts().join("\n")).toContain("The end.");
});

test("one streamed chunk beside 600 rendered blocks costs one small apply", async () => {
	const app = await openProbe(10, 60);
	await app.waitFor("text:streamed 0");
	for (let index = 0; index < 10; index++) await app.press("id:stream");
	await app.waitFor("text:streamed 10");
	const label = app.texts().find((text) => text.startsWith("event at most "));
	const ms = Number(/event at most (\d+) ms/.exec(label ?? "")?.[1]);
	console.log(`one streamed chunk took at most ${ms} ms`);
	expect(ms).toBeLessThan(100);
});

test("a link press reports its url instead of navigating", async () => {
	const app = await openProbe(1, 60);
	await app.waitFor("text:stand link");
	await app.press("text:stand link");
	await app.waitUntil(() =>
		app.texts().some((text) => text.startsWith("linked:")),
	);
	expect(app.texts().join("\n")).toContain("linked:https://stand.dev/x");
	expect(app.openedUrls()).toEqual([]);
});

test("a file link and a project-relative link report their raw urls", async () => {
	const app = await openProbe(1, 60);
	await app.waitFor("text:A file link and a project link here.");
	await app.press("text:file link >> nth=0");
	await app.waitUntil(() => app.texts().some((text) => text.includes("file:")));
	await app.press("text:project link >> nth=0");
	await app.waitUntil(() =>
		app.texts().some((text) => text.includes("src/file-8.ts")),
	);
});

test("the built-in copy action puts a code block on the clipboard", async () => {
	const app = await openProbe(1, 60);
	await app.waitFor("text:export const solo: number = 1;");
	await app.hover("text:export const solo: number = 1;");
	await app.press("id:probe-solo >> label:copy");
	expect(app.clipboard()).toContain("export const solo: number = 1;");
});

test("a data-url image and a remote image both mount", async () => {
	const app = await openProbe(0);
	await app.waitFor("text:streamed 0");
	await app.press("id:imgdata");
	await app.waitFor("text:Above the image");
	await app.waitFor("text:Below the image");
	await app.press("id:imgremote");
	await app.waitFor("text:Above the image");
});
