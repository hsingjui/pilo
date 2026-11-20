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

test("@ starts on its file tab; Tab switches to sessions and a row is picked", async () => {
	const app = await open("./composer-idle-fixture.tsx", { platform: "macos" });
	await app.type("id:chat-composer-input", "@");
	await app.waitFor("id:chat-composer-suggestion:0 >> text:a.ts");
	// A bare `@` gives the keys to the tabs, with the Tab hint.
	expect(app.shows("text:Switch tabs")).toBe(true);
	await app.keyboard.press("tab");
	await app.waitFor("id:chat-composer-suggestion:0 >> text:Earlier chat");
	expect(app.shows("text:a.ts")).toBe(false);
	await app.keyboard.press("down");
	expect(app.shows("text:Switch tabs")).toBe(false);
	// Up from the first row goes back to the tabs.
	await app.keyboard.press("arrowup");
	expect(app.shows("text:Switch tabs")).toBe(true);
	await app.keyboard.press("down");
	await app.keyboard.press("enter");
	expect(app.value("id:chat-composer-input")).toBe("@/sessions/earlier.jsonl ");
	expect(app.shows("id:chat-composer-suggestions")).toBe(false);
});

test("the @ tabs and rows take the pointer", async () => {
	const app = await open("./composer-idle-fixture.tsx", { platform: "macos" });
	await app.type("id:chat-composer-input", "@");
	await app.waitFor("id:chat-composer-suggestion:0 >> text:a.ts");
	await app.press("id:chat-composer-mention-tab:session");
	await app.waitFor("id:chat-composer-suggestion:0 >> text:Earlier chat");
	await app.press("id:chat-composer-mention-tab:file");
	await app.waitFor("id:chat-composer-suggestion:0 >> text:a.ts");
	await app.press("id:chat-composer-suggestion:0");
	expect(app.value("id:chat-composer-input")).toBe('@"src/a.ts" ');
});

test("an @ query without matches, or whose search fails, says so", async () => {
	const app = await open("./composer-idle-fixture.tsx", { platform: "macos" });
	await app.type("id:chat-composer-input", "@zzz");
	await app.waitFor("text:No File matches “zzz”");
	await app.clear("id:chat-composer-input");
	await app.type("id:chat-composer-input", "@fail");
	await app.waitFor("text:No File matches “fail”");
	expect(app.count("id:chat-composer-suggestion:0")).toBe(0);
});
