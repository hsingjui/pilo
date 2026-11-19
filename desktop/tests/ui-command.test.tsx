import { expect, open, test } from "nsh/test";

test("Command filters labels and keywords without case, selects and skips disabled rows", async () => {
	const app = await open("./ui-command-fixture.tsx", {
		platform: "macos",
		width: 960,
		height: 800,
	});
	await app.press("id:focus");
	await app.waitFor("text:Highlighted: new");
	await app.keyboard.press("down");
	await app.waitFor("text:Highlighted: settings");
	await app.keyboard.press("enter");
	await app.waitFor("text:Selected: settings");
	await app.press("text:Archive session").catch((error: unknown) => {
		expect(String(error)).toContain("is disabled");
	});
	expect(app.shows("text:Selected: settings")).toBe(true);
	await app.type("label:Find commands", "PrEfErEnCeS");
	await app.waitFor("text:New session", { state: "gone" });
	await app.waitFor("text:Settings");
	await app.press("text:Settings");
	await app.waitFor("text:Selected: settings");
	await app.clear("label:Find commands");
	await app.type("label:Find commands", "missing");
	await app.waitFor("text:No matching commands");
	await app.keyboard.press("escape");
	await app.waitFor("text:Query: ");
	await app.keyboard.press("escape");
	await app.waitFor("text:Cancelled: 1");
});

test("Command supports controlled query, caller filtering, empty and loading states", async () => {
	const app = await open("./ui-command-fixture.tsx", {
		platform: "macos",
		width: 960,
		height: 800,
	});
	await app.press("id:controlled");
	await app.type("label:Find commands", "folders");
	await app.waitFor("text:Query: folders");
	await app.waitFor("text:Projects");
	await app.waitFor("text:Settings", { state: "gone" });
	await app.press("id:unfiltered");
	await app.clear("label:Find commands");
	await app.type("label:Find commands", "missing");
	await app.waitFor("text:Settings");
	await app.press("id:empty");
	await app.waitFor("text:No matching commands");
	await app.press("id:loading");
	await app.waitFor("text:No matching commands", { state: "gone" });
	await app.press("id:loading");
	await app.waitFor("text:No matching commands");
});

test("Command retains caller geometry, shortcuts and live theme text colors", async () => {
	const app = await open("./ui-command-fixture.tsx", {
		platform: "macos",
		width: 960,
		height: 800,
	});
	await app.press("id:measure");
	await app.waitFor("text:Command: 638x388; matches 4");
	for (const theme of ["Lody", "Claude"]) {
		if (theme === "Claude") await app.press("id:claude");
		for (const scheme of ["light", "dark"] as const) {
			await app.setColorScheme(scheme);
			expect(app.viewStyle("id:command")?.backgroundColor).toBe(
				app.viewStyle("id:reference-popover")?.backgroundColor,
			);
			expect(app.spanStyle("text:New session").color).toBe(
				app.spanStyle("text:Foreground").color,
			);
			expect(app.spanStyle("text:Sessions").color).toBe(
				app.spanStyle("text:Muted").color,
			);
			expect(app.spanStyle("text:⌘N").color).toBe(
				app.spanStyle("text:Muted").color,
			);
		}
	}
	await app.press("id:custom");
	expect(app.spanStyle("text:New session").color).toBe(
		app.spanStyle("text:Custom color").color,
	);
	expect(app.spanStyle("text:Projects").color).toBe(
		app.spanStyle("text:Custom color").color,
	);
});

test("Command scrolls a virtualized overflow list to its last selectable item", async () => {
	const app = await open("./ui-command-fixture.tsx", {
		platform: "macos",
		width: 960,
		height: 800,
	});
	await app.press("id:many");
	await app.scroll("id:command", 10000);
	await app.waitFor("text:Extra command 39");
	await app.press("text:Extra command 39");
	await app.waitFor("text:Selected: extra-39");
});

test("CommandDialog opens, selects and closes through native Escape and backdrop", async () => {
	const app = await open("./ui-command-fixture.tsx", {
		platform: "macos",
		width: 960,
		height: 800,
	});
	await app.press("id:open");
	await app.waitFor("label:Find dialog commands");
	await app.type("label:Find dialog commands", "folders");
	await app.waitFor("text:Projects");
	await app.keyboard.press("enter");
	await app.waitFor("label:Find dialog commands", { state: "gone" });
	await app.press("id:open");
	await app.waitFor("label:Find dialog commands");
	await app.keyboard.press("escape");
	await app.waitFor("label:Find dialog commands", { state: "gone" });
	await app.press("id:open");
	await app.waitFor("label:Find dialog commands");
	await app.press("id:corner");
	await app.press("id:backdrop");
	await app.waitFor("label:Find dialog commands", { state: "gone" });
});

test("CommandDialog follows its viewport-relative top, height cap and narrow-window width", async () => {
	const app = await open("./ui-command-fixture.tsx", {
		platform: "macos",
		width: 960,
		height: 800,
	});
	await app.press("id:open");
	await app.waitFor("label:Find dialog commands");
	await app.press("id:measure-modal");
	await app.waitFor("text:Modal geometry: 638x558 at 161,97");
	await app.setViewport(800, 600);
	await app.press("id:measure-modal");
	await app.waitFor("text:Modal geometry: 638x430 at 81,73");
	await app.setViewport(500, 600);
	await app.press("id:measure-modal");
	await app.waitFor("text:Modal geometry: 450x430 at 25,73");
});
