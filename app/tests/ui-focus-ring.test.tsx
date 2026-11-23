import { expect, open, test } from "nsh/test";
import type { MouseEvent, ViewRef } from "nsh";
import { blurOnPointerPress, focusRingStyle } from "../ui/focus-ring-style";
import lody from "../../theme/theme.json";
import claude from "../../theme/claude-theme.json";

test("Focused styles compose the ring with variant and field shadows, with caller style last", () => {
	for (const theme of [lody, claude]) {
		for (const name of [
			"pilo-button-primary-shadow",
			"pilo-button-secondary-shadow",
			"pilo-field-shadow",
		] as const) {
			const shadow = theme.styleVars.theme[name];
			const caller = [{ opacity: 0.8 }, { boxShadow: "none" }];
			expect(focusRingStyle("red", shadow, caller)).toEqual([
				{
					boxShadow: `0 0 0 1px color-mix(in srgb, red 60%, transparent), ${shadow}`,
				},
				caller,
			]);
		}
	}
});

test("Focused styles keep the ring for absent, empty and explicitly absent base shadows", () => {
	for (const shadow of [undefined, "", "none"]) {
		expect(focusRingStyle("blue", shadow)).toEqual([
			{ boxShadow: "0 0 0 1px color-mix(in srgb, blue 60%, transparent)" },
			undefined,
		]);
	}
});

test("Switch and Tab focus styles preserve their 2px ring and background offset", () => {
	expect(
		focusRingStyle("blue", "0 1px 2px #0001", undefined, {
			width: 2,
			opacity: 100,
			offset: 2,
			offsetColor: "white",
		}),
	).toEqual([
		{ boxShadow: "0 0 0 2px white, 0 0 0 4px blue, 0 1px 2px #0001" },
		undefined,
	]);
});

test("Gallery controls retain keyboard activation and the pointer scrollbar adds no Tab stop", async () => {
	const app = await open("./ui-focus-gallery-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 900,
	});
	await app.press("id:before-bar");
	await app.keyboard.press("tab");
	await app.keyboard.press("space");
	await app.waitFor("text:After scrollbar · 1");
	for (let i = 0; i < 4; i++) await app.keyboard.press("shift+tab");
	await app.keyboard.press("space");
	await app.waitFor("text:Switch: true");
	await app.keyboard.press("tab");
	await app.keyboard.press("tab");
	await app.keyboard.press("enter");
	await app.waitFor("text:Fast");
	await app.keyboard.press("escape");
});

test("Input and Button take keyboard focus at the Dialog content edges in both themes", async () => {
	const app = await open("./ui-dialog-edges-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 600,
	});
	for (const [index, theme] of ["Lody", "Claude"].entries()) {
		if (theme === "Claude") await app.press("id:claude");
		await app.press("id:open");
		await app.waitFor(`text:Full-width bottom button · ${index}`);
		await app.keyboard.press("tab");
		expect(
			app.texts().some((text) => text.endsWith("Input focused: true")),
		).toBe(true);
		await app.keyboard.press("tab");
		expect(
			app.texts().some((text) => text.endsWith("Input focused: false")),
		).toBe(true);
		await app.keyboard.press("space");
		await app.waitFor(`text:Full-width bottom button · ${index + 1}`);
		await app.keyboard.press("escape");
		await app.waitFor(`text:Full-width bottom button · ${index + 1}`, {
			state: "gone",
		});
	}
});

test("blurOnPointerPress blurs on mouse up and forwards ref and onMouseUp", () => {
	const events: string[] = [];
	let received: ViewRef | undefined;
	const fakeNode = {
		blur: () => events.push("blur"),
	} as unknown as ViewRef;
	const fakeEvent = {} as MouseEvent;
	const props = blurOnPointerPress({
		ref: (el) => {
			received = el;
		},
		onMouseUp: (event) => {
			expect(event).toBe(fakeEvent);
			events.push("mouseUp");
		},
	});
	props.ref(fakeNode);
	expect(received).toBe(fakeNode);
	props.onMouseUp(fakeEvent);
	expect(events).toEqual(["blur", "mouseUp"]);
});
