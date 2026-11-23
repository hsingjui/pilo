import { expect, open, test } from "nsh/test";

test("the composer types, submits a prompt and clears", async () => {
	const app = await open("./composer-idle-fixture.tsx", { platform: "macos" });
	await app.type("id:chat-composer-input", "do the thing");
	await app.submit("id:chat-composer-input");
	await app.waitFor("text:sent:prompt");
	expect(app.shows("id:composer-last-message >> text:do the thing")).toBe(true);
	expect(app.shows("id:chat-composer-input >> text:do the thing")).toBe(false);
});

test("switching chats keeps the project draft but starts a fresh undo history", async () => {
	const app = await open("./composer-idle-fixture.tsx", { platform: "macos" });
	await app.type("id:chat-composer-input", "project draft");
	await app.press("id:fixture-switch-chat");
	await app.waitFor("id:chat-composer-input >> text:project draft");
	await app.type("id:chat-composer-input", " discard this");
	await app.keyboard.press("mod+z");
	await app.waitFor("id:chat-composer-input >> text:discard this", {
		state: "gone",
	});
	expect(app.shows("id:chat-composer-input >> text:project draft")).toBe(true);
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
	expect(app.shows("id:composer-last-message >> text:adjust")).toBe(true);
});

test("@ starts on its file tab; Tab switches to sessions and renders inline + tray without raw path", async () => {
	const app = await open("./composer-idle-fixture.tsx", { platform: "macos" });
	await app.type("id:chat-composer-input", "@");
	await app.waitFor(
		"id:chat-composer-suggestion:0 >> text:chat-user-message-body.tsx",
	);
	// A bare `@` gives the keys to the tabs, with the Tab hint.
	expect(app.shows("text:Switch tabs")).toBe(true);
	await app.keyboard.press("tab");
	await app.waitFor("id:chat-composer-suggestion:0 >> text:Earlier chat");
	expect(app.shows("text:chat-user-message-body.tsx")).toBe(false);
	await app.keyboard.press("down");
	expect(app.shows("text:Switch tabs")).toBe(false);
	// Up from the first row goes back to the tabs.
	await app.keyboard.press("arrowup");
	expect(app.shows("text:Switch tabs")).toBe(true);
	await app.keyboard.press("down");
	await app.keyboard.press("enter");
	expect(app.shows("id:chat-composer-suggestions")).toBe(false);
	// 上方附件区和输入框都展示会话标题，不暴露原始路径文本。
	expect(
		app.shows("id:chat-composer-attachment:session >> text:Earlier chat"),
	).toBe(true);
	expect(
		app.shows("id:chat-composer-mention:session >> text:Earlier chat"),
	).toBe(true);
	expect(app.shows("text:@/sessions/earlier.jsonl")).toBe(false);
	// 提交时仍序列化为既有的纯文本协议。
	await app.submit("id:chat-composer-input");
	await app.waitFor("text:sent:prompt");
	expect(
		app.shows("id:composer-last-message >> text:@/sessions/earlier.jsonl"),
	).toBe(true);
});

test("the @ tabs and rows take the pointer, hover shows full path, and tray remove syncs editor", async () => {
	const app = await open("./composer-idle-fixture.tsx", {
		platform: "macos",
		width: 600,
		height: 500,
	});
	await app.type("id:chat-composer-input", "@");
	await app.waitFor(
		"id:chat-composer-suggestion:0 >> text:chat-user-message-body.tsx",
	);
	await app.press("id:chat-composer-mention-tab:session");
	await app.waitFor("id:chat-composer-suggestion:0 >> text:Earlier chat");
	await app.press("id:chat-composer-mention-tab:file");
	await app.waitFor(
		"id:chat-composer-suggestion:0 >> text:chat-user-message-body.tsx",
	);
	await app.press("id:chat-composer-suggestion:0");

	expect(
		app.shows(
			"id:chat-composer-attachment:file >> text:chat-user-message-body.tsx",
		),
	).toBe(true);
	expect(
		app.shows(
			"id:chat-composer-mention:file >> text:chat-user-message-body.tsx",
		),
	).toBe(true);
	expect(app.shows('text:@"src/chat-user-message-body.tsx"')).toBe(false);

	// 点击输入框内联节点保持可点击且不报错。
	await app.press("id:chat-composer-mention:file");
	// 悬停输入框内联节点展示完整路径。
	await app.hover("id:chat-composer-mention:file");
	await app.waitFor("text:src/chat-user-message-body.tsx");

	// 上传图片在上方附件区和输入框内部均内联展示，悬停展示详情，移除同步生效。
	await app.press("id:fixture-attach-image");
	await app.waitFor("id:chat-composer-image >> text:shot.png");
	expect(app.shows("id:chat-composer-mention:image >> text:shot.png")).toBe(
		true,
	);
	await app.press("id:chat-composer-mention:image");
	await app.hover("id:chat-composer-mention:image");
	await app.waitFor("text:/shot\\.png · /");

	// 移除上方文件芯片同步从输入框移除内联节点。
	await app.press("label:Remove chat-user-message-body.tsx");
	expect(app.shows("id:chat-composer-attachment:file")).toBe(false);
	expect(app.shows("id:chat-composer-mention:file")).toBe(false);
	// 图片芯片与输入框内联图片节点不受影响。
	expect(app.shows("id:chat-composer-image >> text:shot.png")).toBe(true);
	expect(app.shows("id:chat-composer-mention:image >> text:shot.png")).toBe(
		true,
	);

	// 同项目切换会话后仍能看到图片；移除后，切回去也不会恢复它。
	await app.press("id:fixture-switch-chat");
	await app.waitFor("id:chat-composer-mention:image >> text:shot.png");
	await app.press("label:Remove shot.png");
	await app.waitFor("id:chat-composer-mention:image", { state: "gone" });
	await app.press("id:fixture-switch-chat");
	expect(app.shows("id:chat-composer-image")).toBe(false);
	expect(app.shows("id:chat-composer-mention:image")).toBe(false);
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

test("/ shows built-in allowlisted commands and cached skill/prompt commands, filters and picks", async () => {
	const app = await open("./composer-idle-fixture.tsx", { platform: "macos" });
	await app.type("id:chat-composer-input", "/");
	await app.waitFor("id:chat-composer-suggestion:0 >> text:/new");
	expect(app.shows("text:/compact")).toBe(true);
	expect(app.shows("text:/skill:review")).toBe(true);
	expect(app.shows("text:/plan")).toBe(true);
	// Filter down to the skill command and pick it with Enter.
	await app.type("id:chat-composer-input", "review");
	await app.waitFor("id:chat-composer-suggestion:0 >> text:/skill:review");
	await app.keyboard.press("enter");
	expect(app.shows("id:chat-composer-input >> text:/skill:review ")).toBe(true);
	expect(app.shows("id:chat-composer-suggestions")).toBe(false);
});

test("/ unmatched query shows empty state and /new triggers a new chat", async () => {
	const app = await open("./composer-idle-fixture.tsx", { platform: "macos" });
	await app.type("id:chat-composer-input", "/zzz");
	await app.waitFor("text:No Pi command matches “zzz”");
	await app.clear("id:chat-composer-input");
	await app.type("id:chat-composer-input", "/new");
	await app.waitFor("id:chat-composer-suggestion:0 >> text:/new");
	await app.keyboard.press("enter");
	await app.submit("id:chat-composer-input");
	await app.waitFor("text:new-chat");
});

test("/ merges live extension commands on a running session and excludes /llama", async () => {
	const app = await open("./composer-running-fixture.tsx", {
		platform: "macos",
	});
	await app.type("id:chat-composer-input", "/");
	await app.waitFor("text:/deploy");
	expect(app.shows("text:/new")).toBe(true);
	expect(app.shows("text:/compact")).toBe(true);
	expect(app.shows("text:/skill:review")).toBe(true);
	expect(app.shows("text:/llama")).toBe(false);
});
