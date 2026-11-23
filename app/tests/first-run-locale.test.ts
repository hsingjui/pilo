import { expect, open, test } from "nsh/test";

async function expectStartupLocale(
	mode: string,
	locale: string,
	saved: string,
) {
	const app = await open("./first-run-locale-fixture.tsx", {
		locale,
		host: { params: { mode } },
	});
	await app.waitFor(`text:startup locale: ${locale}; Host: ${saved}`);
}

test("a fresh Host takes the Chinese macOS locale", async () => {
	await expectStartupLocale("fresh", "zh-CN", "zh-CN");
});

test("first-run initialization preserves an explicitly saved English locale", async () => {
	await expectStartupLocale("saved", "zh-CN", "en-US");
});

test("a reopened Host keeps its locale after the macOS locale changes", async () => {
	await expectStartupLocale("reopen", "en-US", "zh-CN");
});

test("the shell shows loading while the Host locale seed is pending", async () => {
	const app = await open("./first-run-locale-fixture.tsx", {
		locale: "en-US",
		host: { params: { mode: "pending" } },
	});
	await app.waitFor("id:startup-loading");
	expect(app.shows("id:workspace >> label:Loading…")).toBe(true);
	expect(app.shows("id:workspace-title")).toBe(false);
});
