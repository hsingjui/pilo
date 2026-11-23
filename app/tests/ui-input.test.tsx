import { expect, open, test } from "nsh/test";
import lody from "../../theme/theme.json";
import { windowsMonoInputStyle } from "../ui/input";

test("Input starts empty, reports typed changes, submits and clears", async () => {
	const app = await open("./ui-input-fixture.tsx", { platform: "macos" });
	expect(app.value("id:input")).toBe("");
	await app.type("id:input", "Pilo");
	expect(app.value("id:input")).toBe("Pilo");
	expect(app.shows("text:Value: Pilo")).toBe(true);
	expect(app.shows("text:Changes: 4")).toBe(true);
	await app.submit("id:input");
	expect(app.shows("text:Submitted: Pilo")).toBe(true);
	await app.clear("id:input");
	expect(app.value("id:input")).toBe("");
	await app.press("id:measure");
	await app.waitFor("text:Field height: 36");
	await app.waitFor(
		`text:Shadow: ${lody.styleVars.theme["pilo-field-shadow"]}`,
	);
});

test("Input supports uncontrolled defaults and multiline edits, and rejects disabled edits", async () => {
	const app = await open("./ui-input-fixture.tsx", { platform: "macos" });
	expect(app.value("id:uncontrolled")).toBe("Initial");
	await app.type("id:uncontrolled", " title");
	expect(app.value("id:uncontrolled")).toBe("Initial title");
	expect(app.enabled("id:disabled")).toBe(false);
	await app.type("id:disabled", "changed").catch((error: unknown) => {
		expect(String(error)).toContain("not editable");
	});
	expect(app.value("id:disabled")).toBe("Unchanged");
	expect(app.shows("text:Changes: 0")).toBe(true);
	expect(app.shows("text:Value: Incorrect disabled edit")).toBe(false);
	await app.type("id:multiline", "First\nSecond");
	expect(app.value("id:multiline")).toBe("First\nSecond");
	expect(app.shows("text:Notes: First\nSecond")).toBe(true);
});

test("Windows font-mono inputs fall back to ui-monospace to avoid baseline clipping", () => {
	expect(
		windowsMonoInputStyle(
			"h-7 w-18 text-right font-mono text-[10px]",
			"windows",
		),
	).toEqual({ fontFamily: "ui-monospace" });
	expect(windowsMonoInputStyle("font-mono", "windows")).toEqual({
		fontFamily: "ui-monospace",
	});
	expect(windowsMonoInputStyle("min-h-11 font-sans text-xs", "windows")).toBe(
		undefined,
	);
	expect(
		windowsMonoInputStyle("h-7 w-18 text-right font-mono text-[10px]", "macos"),
	).toBe(undefined);
});
