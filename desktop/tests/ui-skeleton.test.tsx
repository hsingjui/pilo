import { expect, open, test } from "nsh/test";

test("Skeleton uses theme line/strong colors in both appearances and both themes", async () => {
	const app = await open("./ui-skeleton-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 600,
	});
	for (const theme of ["Lody", "Claude"]) {
		if (theme === "Claude") await app.press("id:claude");
		for (const scheme of ["light", "dark"] as const) {
			await app.setColorScheme(scheme);
			for (const variant of ["line", "strong"])
				expect(app.viewStyle(`id:${variant}`)?.backgroundColor).toBe(
					app.viewStyle(`id:${variant}-reference`)?.backgroundColor,
				);
		}
	}
});

test("Skeleton keeps explicit and empty geometry with reduced motion", async () => {
	const app = await open("./ui-skeleton-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 600,
		reducedMotion: true,
	});
	expect(app.shows("text:Reduced motion: static bones")).toBe(true);
	await app.press("id:measure");
	expect(app.shows("text:288x12, 736x0")).toBe(true);
});

test("Skeleton fixture blocks JS for at least 1.5 seconds then resumes", async () => {
	const app = await open("./ui-skeleton-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 600,
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
