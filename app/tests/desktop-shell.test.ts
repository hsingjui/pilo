import { signal } from "nsh";
import type { WindowState } from "nsh/desktop";
import { expect, test } from "nsh/test";

import {
	createWindowVisibilityController,
	type DesktopDockApi,
	type WindowVisibilityTarget,
} from "../shell/desktop-shell";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function createFakeWindow(initialVisible = true) {
	const visible = signal(initialVisible);
	const events: string[] = [];
	const focusListeners = new Set<(event: { focused: boolean }) => void>();

	const target: WindowVisibilityTarget = {
		focus: () => {
			events.push("window:focus");
			visible.set(true);
		},
		hide: () => {
			events.push("window:hide");
			visible.set(false);
		},
		state: () =>
			({
				visible: visible(),
			}) as WindowState,
		on: (_event, listener) => {
			focusListeners.add(listener);
			return () => {
				focusListeners.delete(listener);
			};
		},
	};

	return {
		target,
		events,
		setVisibleExternally: (next: boolean) => {
			visible.set(next);
		},
		emitFocus: (focused: boolean) => {
			for (const listener of focusListeners) listener({ focused });
		},
	};
}

test("hides Dock on window hide and restores Dock before focusing on show", async () => {
	const win = createFakeWindow(true);
	const dock: DesktopDockApi = {
		setVisible: async (next) => {
			win.events.push(`dock:${next}`);
			return true;
		},
	};
	const controller = createWindowVisibilityController(
		win.target,
		dock,
		() => false,
	);

	controller.hide();
	await flush();
	expect(win.events).toEqual(["window:hide", "dock:false"]);

	win.events.length = 0;
	controller.show();
	await flush();
	expect(win.events).toEqual(["dock:true", "window:focus"]);
	controller.dispose();
});

test("stale show completion does not focus after a newer hide", async () => {
	const win = createFakeWindow(false);
	const pending: Array<{
		visible: boolean;
		resolve: (value: boolean) => void;
	}> = [];
	const dock: DesktopDockApi = {
		setVisible: (next) =>
			new Promise<boolean>((resolve) => {
				win.events.push(`dock:start:${next}`);
				pending.push({ visible: next, resolve });
			}),
	};
	const controller = createWindowVisibilityController(
		win.target,
		dock,
		() => false,
	);

	controller.show();
	controller.hide();
	pending[0]?.resolve(true);
	pending[1]?.resolve(true);
	await flush();

	expect(win.events).toEqual([
		"dock:start:true",
		"window:hide",
		"dock:start:false",
	]);
	controller.dispose();
});

test("Dock visibility errors do not block showing the main window", async () => {
	const win = createFakeWindow(false);
	const dock: DesktopDockApi = {
		setVisible: async () => {
			win.events.push("dock:error");
			throw new Error("AppKit unavailable");
		},
	};
	const controller = createWindowVisibilityController(
		win.target,
		dock,
		() => false,
	);

	controller.show();
	await flush();
	expect(win.events).toEqual(["dock:error", "window:focus"]);
	controller.dispose();
});

test("restores Dock when a hidden window becomes visible or focused externally", async () => {
	const win = createFakeWindow(true);
	const dockCalls: boolean[] = [];
	const dock: DesktopDockApi = {
		setVisible: async (next) => {
			dockCalls.push(next);
			return true;
		},
	};
	const controller = createWindowVisibilityController(
		win.target,
		dock,
		() => false,
	);

	controller.hide();
	await flush();
	expect(dockCalls).toEqual([false]);

	win.setVisibleExternally(true);
	await flush();
	expect(dockCalls).toEqual([false, true]);

	controller.hide();
	await flush();
	expect(dockCalls).toEqual([false, true, false]);

	win.emitFocus(true);
	await flush();
	expect(dockCalls).toEqual([false, true, false, true]);
	controller.dispose();
});
