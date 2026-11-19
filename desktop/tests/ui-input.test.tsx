import { expect, open, test } from "nsh/test";
import lody from "../theme.json";

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
	expect(app.shows("text:Field height: 36")).toBe(true);
	expect(
		app.shows(`text:Shadow: ${lody.styleVars.theme["pilo-field-shadow"]}`),
	).toBe(true);
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
