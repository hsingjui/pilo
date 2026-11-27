import { expect, test } from "nsh/test";

import { webDesktopShell } from "../../web/web-desktop-shell";

test("browser saves request a named download and remove the link even when clicking fails", async () => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
	try {
		Object.defineProperty(globalThis, "document", {
			configurable: true,
			value: undefined,
		});
		const saveImage = webDesktopShell.saveImage!;
		const bytes = new Uint8Array([1, 2, 3]);
		expect(await saveImage("image.png", bytes)).toBe(false);

		const actions: string[] = [];
		const failure = new Error("download blocked");
		let blocked = false;
		const link = {
			href: "",
			download: "",
			click() {
				actions.push("clicked");
				if (blocked) throw failure;
			},
			remove: () => actions.push("removed"),
		};
		Object.defineProperty(globalThis, "document", {
			configurable: true,
			value: {
				createElement: (tag: string) => {
					expect(tag).toBe("a");
					return link;
				},
				body: {
					appendChild: (child: typeof link) => {
						expect(child).toBe(link);
						actions.push("added");
					},
				},
			},
		});
		expect(await saveImage("image.png", bytes)).toBe(true);
		expect(link.download).toBe("image.png");
		expect(link.href.startsWith("blob:")).toBe(true);

		blocked = true;
		let caught: unknown;
		try {
			await saveImage("blocked.png", bytes);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBe(failure);
		expect(actions).toEqual([
			"added",
			"clicked",
			"removed",
			"added",
			"clicked",
			"removed",
		]);
	} finally {
		if (previous) Object.defineProperty(globalThis, "document", previous);
		else Reflect.deleteProperty(globalThis, "document");
	}
});
