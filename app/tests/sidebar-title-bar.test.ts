import { expect, test } from "nsh/test";

import {
	sidebarTitleBarHeight,
	TITLE_BAR_HEIGHT,
	windowTitleBarOptions,
} from "../shell/sidebar-panel";

const lodyCard = { frameTop: 9, frameLeft: 9, radius: 12 };
const dockedCard = { frameTop: 0, frameLeft: 0, radius: 0 };

test("macOS floating sidebar cards inset traffic lights inside the card frame", () => {
	const options = windowTitleBarOptions(lodyCard, "macos");
	expect(options).toEqual({
		style: "hidden",
		height: 54,
		controlsOffset: { x: 21, y: 20 },
	});
	// The sidebar title row stays inside the card's top border and shares its
	// vertical midpoint with the hidden window title bar.
	const rowHeight = sidebarTitleBarHeight(options.height, lodyCard);
	expect(rowHeight).toBe(36);
	expect(lodyCard.frameTop + rowHeight / 2).toBe(options.height / 2);

	// If macOS reports a taller title bar (for instance 16pt traffic lights),
	// the floating header row expands to stay vertically centered with it.
	const tallRowHeight = sidebarTitleBarHeight(56, lodyCard);
	expect(tallRowHeight).toBe(38);
	expect(lodyCard.frameTop + tallRowHeight / 2).toBe(28);
});

test("docked themes keep the standard macOS title bar with default traffic lights", () => {
	const options = windowTitleBarOptions(dockedCard, "macos");
	expect(options).toEqual({
		style: "hidden",
		height: TITLE_BAR_HEIGHT,
		controlsOffset: null,
	});
	expect(sidebarTitleBarHeight(options.height, dockedCard)).toBe(
		TITLE_BAR_HEIGHT,
	);
});

test("Windows keeps the standard title bar height and centers the floating sidebar header inside the card", () => {
	for (const os of ["windows", "linux"]) {
		const floating = windowTitleBarOptions(lodyCard, os);
		expect(floating).toEqual({
			style: "hidden",
			height: TITLE_BAR_HEIGHT,
			controlsOffset: null,
		});
		expect(sidebarTitleBarHeight(floating.height, lodyCard)).toBe(36);

		const docked = windowTitleBarOptions(dockedCard, os);
		expect(docked).toEqual({
			style: "hidden",
			height: TITLE_BAR_HEIGHT,
			controlsOffset: null,
		});
		expect(sidebarTitleBarHeight(docked.height, dockedCard)).toBe(
			TITLE_BAR_HEIGHT,
		);
	}
});
