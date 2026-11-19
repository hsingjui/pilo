import { open, test } from "nsh/test";

test("Pilo starts a Pi chat and returns its ready process snapshot", async () => {
	const app = await open("./chat-lifecycle-fixture.tsx");
	await app.waitFor("text:startChat verified", { timeout: 15000 });
});

test("Pilo stops a running chat and accepts a repeated stop", async () => {
	const app = await open("./chat-lifecycle-fixture.tsx", {
		host: { params: { stop: true } },
	});
	await app.waitFor("text:stopChat verified", { timeout: 15000 });
});

test("Pilo returns live chat state only while the session is running", async () => {
	const app = await open("./chat-lifecycle-fixture.tsx", {
		host: { params: { state: true } },
	});
	await app.waitFor("text:chatState verified", { timeout: 15000 });
});

test("Pilo forwards Pi RPC commands and delivers responses through events", async () => {
	const app = await open("./chat-lifecycle-fixture.tsx", {
		host: { params: { command: true } },
	});
	await app.waitFor("text:sendChatCommand verified", { timeout: 15000 });
});

test("Pilo shutdown closes the stream and stops a Pi child mid-turn", async () => {
	const app = await open("./chat-lifecycle-fixture.tsx", {
		host: { params: { shutdown: true } },
	});
	await app.waitFor("text:shutdown stops Pi mid-turn", { timeout: 15000 });
});
