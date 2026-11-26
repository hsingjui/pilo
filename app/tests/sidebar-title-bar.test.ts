import { expect, test } from "nsh/test";

import {
	sidebarTitleBarHeight,
	sidebarTitleBarMarginTop,
	TITLE_BAR_HEIGHT,
	windowTitleBarOptions,
} from "../shell/sidebar-panel";

const lodyCard = {
	frameTop: 9,
	frameLeft: 9,
	radius: 12,
	paddingTop: 2,
	top: 11,
};
const dockedCard = {
	frameTop: 0,
	frameLeft: 0,
	radius: 0,
	paddingTop: 8,
	top: 8,
};

test("macOS floating sidebar cards inset traffic lights inside the card frame", () => {
	const options = windowTitleBarOptions(lodyCard, "macos");
	expect(options).toEqual({
		style: "hidden",
		height: 54,
		controlsOffset: { x: 21, y: 20 },
	});
	// The sidebar title row stays inside the card's top border and shares its
	// vertical midpoint with the hidden window title bar.
	const rowHeight = sidebarTitleBarHeight(options.height, lodyCard, "macos");
	expect(rowHeight).toBe(36);
	expect(lodyCard.frameTop + rowHeight / 2).toBe(options.height / 2);
	expect(lodyCard.top + sidebarTitleBarMarginTop(lodyCard, "macos")).toBe(
		lodyCard.frameTop,
	);

	// If macOS reports a taller title bar (for instance 16pt traffic lights),
	// the floating header row expands to stay vertically centered with it.
	const tallRowHeight = sidebarTitleBarHeight(56, lodyCard, "macos");
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
	expect(sidebarTitleBarHeight(options.height, dockedCard, "macos")).toBe(
		TITLE_BAR_HEIGHT,
	);
});

test("Windows and Linux align floating sidebar headers with the window title bar", () => {
	for (const os of ["windows", "linux"]) {
		const floating = windowTitleBarOptions(lodyCard, os);
		expect(floating).toEqual({
			style: "hidden",
			height: TITLE_BAR_HEIGHT,
			controlsOffset: null,
		});
		expect(sidebarTitleBarHeight(floating.height, lodyCard, os)).toBe(
			TITLE_BAR_HEIGHT,
		);
		expect(lodyCard.top + sidebarTitleBarMarginTop(lodyCard, os)).toBe(0);

		const docked = windowTitleBarOptions(dockedCard, os);
		expect(docked).toEqual({
			style: "hidden",
			height: TITLE_BAR_HEIGHT,
			controlsOffset: null,
		});
		expect(sidebarTitleBarHeight(docked.height, dockedCard, os)).toBe(
			TITLE_BAR_HEIGHT,
		);
	}
});
