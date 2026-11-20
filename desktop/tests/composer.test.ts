import { expect, open, test } from "nsh/test";

test("the composer types, submits a prompt and clears", async () => {
	const app = await open("./composer-idle-fixture.tsx", { platform: "macos" });
	await app.type("id:chat-composer-input", "do the thing");
	await app.submit("id:chat-composer-input");
	await app.waitFor("text:sent:prompt");
	expect(app.value("id:chat-composer-input")).toBe("");
});

test("the send button prompts and an unfinished composition does not", async () => {
	const app = await open("./composer-idle-fixture.tsx", { platform: "macos" });
	await app.type("id:chat-composer-input", "hi");
	await app.compose("id:chat-composer-input", "nihao");
	await app.press("label:Send");
	expect(app.shows("text:sent:prompt")).toBe(false);
	await app.compose("id:chat-composer-input", "");
	await app.press("label:Send");
	await app.waitFor("text:sent:prompt");
});

test("a running chat stops and steers", async () => {
	const app = await open("./composer-running-fixture.tsx", {
		platform: "macos",
	});
	await app.press("label:Stop");
	await app.waitFor("text:sent:abort");
	await app.type("id:chat-composer-input", "adjust");
	await app.submit("id:chat-composer-input");
	await app.waitFor("text:sent:steer");
});
