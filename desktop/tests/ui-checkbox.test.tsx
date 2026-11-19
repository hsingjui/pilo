import { expect, open, test } from "nsh/test";

test("Checkbox toggles, resolves indeterminate to checked, and preserves caller ownership", async () => {
	const app = await open("./ui-checkbox-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 700,
	});
	expect(app.shows("label:Choose session")).toBe(true);
	await app.press("id:control");
	expect(app.shows("text:Checked: true · Mixed: true/false · Changes: 1")).toBe(
		true,
	);
	await app.press("id:control");
	await app.press("id:mixed");
	expect(
		app.shows("text:Checked: false · Mixed: false/true · Changes: 3"),
	).toBe(true);
	await app.press("id:mixed");
	expect(
		app.shows("text:Checked: false · Mixed: false/false · Changes: 4"),
	).toBe(true);
	await app.press("id:locked");
	expect(app.texts().some((text) => text.includes("Locked event: false"))).toBe(
		true,
	);
	expect(app.viewStyle("id:locked")?.backgroundColor).toBe(
		app.viewStyle("id:primary-reference")?.backgroundColor,
	);
	await app.press("id:default");
	expect(app.texts().some((text) => text.startsWith("Default: false"))).toBe(
		true,
	);
});

test("Checkbox ignores disabled presses and keeps empty/checked geometry", async () => {
	const app = await open("./ui-checkbox-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 700,
	});
	for (const id of ["disabled", "disabled-checked", "disabled-mixed"]) {
		try {
			await app.press(`id:${id}`);
		} catch (error) {
			expect((error as { code?: string }).code).toBe("ERR_NSH_TEST_DISABLED");
		}
		expect(app.viewStyle(`id:${id}`)?.opacity).toBe(0.5);
	}
	expect(
		app.shows("text:Checked: false · Mixed: true/false · Changes: 0"),
	).toBe(true);
	await app.press("id:measure");
	expect(app.shows("text:16x16, 16x16")).toBe(true);
});

test("Checkbox matches checked, mixed and unchecked colors in both themes and appearances", async () => {
	const app = await open("./ui-checkbox-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 700,
	});
	for (const theme of ["Lody", "Claude"]) {
		if (theme === "Claude") await app.press("id:claude");
		for (const scheme of ["light", "dark"] as const) {
			await app.setColorScheme(scheme);
			for (const id of [
				"locked",
				"mixed",
				"disabled-checked",
				"disabled-mixed",
			])
				expect(app.viewStyle(`id:${id}`)?.backgroundColor).toBe(
					app.viewStyle("id:primary-reference")?.backgroundColor,
				);
			expect(app.viewStyle("id:control")?.backgroundColor).toBe(
				app.viewStyle("id:empty-reference")?.backgroundColor,
			);
		}
	}
});

test("Checkbox takes keyboard focus and activates with Space and Return", async () => {
	const app = await open("./ui-checkbox-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 700,
	});
	await app.press("id:before");
	await app.keyboard.press("tab");
	await app.keyboard.press("space");
	expect(app.shows("text:Checked: true · Mixed: true/false · Changes: 1")).toBe(
		true,
	);
	await app.keyboard.press("enter");
	expect(
		app.shows("text:Checked: false · Mixed: true/false · Changes: 2"),
	).toBe(true);
});

test("Checkbox fixture resumes after blocking JS during its native focus transition", async () => {
	const app = await open("./ui-checkbox-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 700,
	});
	await app.press("id:block");
	await app.waitUntil(() =>
		app.texts().some((text) => text.startsWith("JS resumed after ")),
	);
	const result = app
		.texts()
		.find((text) => text.startsWith("JS resumed after "))!;
	expect(
		Number.parseInt(result.slice("JS resumed after ".length), 10) >= 1500,
	).toBe(true);
});
