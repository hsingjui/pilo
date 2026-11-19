import { expect, open, test } from "nsh/test";

const sizes = (controlled: number, grown = 38) =>
	`text:Sizes: empty 58; controlled ${controlled}; four 98; disabled 58; readonly 58; custom 64; invalid 58; grow ${grown}`;

test("Textarea accepts multiline edits, Return, controlled values and keyboard focus", async () => {
	const app = await open("./ui-textarea-fixture.tsx", {
		platform: "macos",
		width: 960,
		height: 1000,
	});
	expect(app.shows("label:Session notes")).toBe(true);
	expect(app.value("id:empty")).toBe("");
	expect(app.value("id:four")).toBe(
		"First line\nSecond line\nThird line\nFourth line",
	);
	await app.press("id:before");
	await app.keyboard.press("tab");
	await app.waitFor("text:Empty focused: true");
	await app.type("id:empty", "First");
	await app.keyboard.press("enter");
	await app.keyboard.press("s");
	expect(app.value("id:empty")).toBe("First\ns");
	await app.clear("id:controlled");
	await app.type("id:controlled", "Updated\nNotes");
	await app.waitFor("text:Value: Updated\nNotes");
	expect(app.value("id:controlled")).toBe("Updated\nNotes");
});

test("Textarea rows set geometry reactively, with caller sizing and invalid rows fallback", async () => {
	const app = await open("./ui-textarea-fixture.tsx", {
		platform: "macos",
		width: 960,
		height: 1000,
	});
	await app.press("id:measure");
	await app.waitFor(sizes(58));
	await app.press("id:rows");
	await app.waitFor("text:Rows: 4");
	await app.press("id:measure");
	await app.waitFor(sizes(98));
	await app.press("id:rows");
	await app.waitFor("text:Rows: 2");
	await app.press("id:measure");
	await app.waitFor(sizes(58));
});

test("Textarea ignores disabled and read-only edits without changing their values", async () => {
	const app = await open("./ui-textarea-fixture.tsx", {
		platform: "macos",
		width: 960,
		height: 1000,
	});
	expect(app.enabled("id:disabled")).toBe(false);
	for (const id of ["disabled", "readonly"]) {
		await app.type(`id:${id}`, "Changed").catch((error: unknown) => {
			expect(String(error)).toContain("not editable");
		});
	}
	expect(app.value("id:disabled")).toBe("Locked notes");
	expect(app.value("id:readonly")).toBe("Read-only notes");
	expect(app.viewStyle("id:disabled")?.opacity).toBeGreaterThan(0.599);
	expect(app.viewStyle("id:disabled")?.opacity).toBeLessThan(0.601);
});

test("Textarea forwards content size for caller-owned grow, shrink and maximum height", async () => {
	const app = await open("./ui-textarea-fixture.tsx", {
		platform: "macos",
		width: 960,
		height: 1000,
	});
	await app.type("id:grow", "One\nTwo\nThree\nFour");
	const grownHeight = () =>
		Number(
			app
				.texts()
				.find((text) => text.startsWith("Grown: "))
				?.slice(7),
		);
	await app.waitUntil(() => grownHeight() > 38);
	const height = grownHeight();
	expect(height).toBeLessThan(138);
	await app.press("id:measure");
	await app.waitFor(sizes(58, height));
	await app.type("id:grow", "\nFive\nSix\nSeven\nEight");
	await app.waitFor("text:Grown: 138");
	await app.press("id:measure");
	await app.waitFor(sizes(58, 138));
	await app.clear("id:grow");
	await app.waitFor("text:Grown: 38");
	await app.press("id:measure");
	await app.waitFor(sizes(58));
});

test("Textarea field and disabled colors follow both themes and live appearance changes", async () => {
	const app = await open("./ui-textarea-fixture.tsx", {
		platform: "macos",
		width: 960,
		height: 1000,
	});
	for (const theme of ["Lody", "Claude"]) {
		if (theme === "Claude") await app.press("id:claude");
		for (const scheme of ["light", "dark"] as const) {
			await app.setColorScheme(scheme);
			expect(app.viewStyle("id:empty")?.backgroundColor).toBe(
				app.viewStyle("id:reference-field")?.backgroundColor,
			);
			expect(app.viewStyle("id:disabled")?.backgroundColor).toBe(
				app.viewStyle("id:reference-muted")?.backgroundColor,
			);
		}
	}
});
