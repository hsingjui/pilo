import { expect, open, test } from "nsh/test";

test("user message bubble renders inline file and session mentions with tooltips and file open", async () => {
	const app = await open("./chat-user-message-fixture.tsx", {
		platform: "macos",
		width: 680,
		height: 400,
	});
	// 显示文件名和会话名，不显示原始 @ 路径文本。
	expect(
		app.shows("id:chat-user-mention:file >> text:chat-user-message-body.tsx"),
	).toBe(true);
	expect(app.shows("id:chat-user-mention:file >> text:raw.unknownext")).toBe(
		true,
	);
	expect(app.shows("id:chat-user-mention:session >> text:Earlier chat")).toBe(
		true,
	);
	expect(app.shows('text:@"desktop/chat/chat-user-message-body.tsx"')).toBe(
		false,
	);
	expect(app.shows("text:@/sessions/earlier.jsonl")).toBe(false);

	// 悬停文件 mention 展示完整路径。
	await app.hover(
		"id:chat-user-mention:file >> text:chat-user-message-body.tsx",
	);
	await app.waitFor("text:desktop/chat/chat-user-message-body.tsx");

	// 悬停会话 mention 展示完整路径。
	await app.hover("id:chat-user-mention:session");
	await app.waitFor("text:/\\/sessions\\/earlier\\.jsonl/");

	// 点击可预览文件触发 openFile；点击会话保持可点击态不报错。
	await app.press(
		"id:chat-user-mention:file >> text:chat-user-message-body.tsx",
	);
	expect(
		app.shows("id:opened-file >> text:desktop/chat/chat-user-message-body.tsx"),
	).toBe(true);
	await app.press("id:chat-user-mention:session");
});
