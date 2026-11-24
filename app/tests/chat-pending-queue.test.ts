import { expect, open, test } from "nsh/test";

test("shows queued steer/follow_up items, supports retrieve-to-edit and interrupt-and-send-now", async () => {
	const app = await open("./chat-pending-queue-fixture.tsx", {
		platform: "macos",
		width: 640,
		height: 480,
	});

	expect(app.shows("id:chat-pending-queue")).toBe(false);

	// Queue a steer message.
	await app.type("id:chat-composer-input", "change plan");
	await app.submit("id:chat-composer-input");
	await app.waitFor("id:chat-pending-queue");
	expect(app.shows("text:Pending messages")).toBe(true);
	expect(app.shows("id:chat-pending-queue >> text:1")).toBe(true);
	expect(app.shows("id:chat-pending-item-0 >> text:Steer")).toBe(true);
	expect(app.shows("id:chat-pending-item-0 >> text:change plan")).toBe(true);

	// Queue a follow-up message.
	await app.press("id:fixture-mode-follow-up");
	await app.type("id:chat-composer-input", "after that run tests");
	await app.submit("id:chat-composer-input");
	await app.waitFor("id:chat-pending-queue >> text:2");
	expect(app.shows("id:chat-pending-item-1 >> text:Later")).toBe(true);
	expect(app.shows("id:chat-pending-item-1 >> text:after that run tests")).toBe(
		true,
	);

	// Retrieve the first message into the composer; the second stays queued.
	await app.press("id:chat-pending-edit-0");
	await app.waitFor("id:chat-pending-queue >> text:1");
	expect(app.shows("id:chat-composer-input >> text:change plan")).toBe(true);
	expect(app.shows("id:chat-pending-item-0 >> text:after that run tests")).toBe(
		true,
	);

	// Interrupt and send the remaining queued message now.
	await app.press("id:chat-pending-send-now-0");
	await app.waitFor("id:chat-pending-queue", { state: "gone" });
	expect(app.shows("text:prompt:after that run tests")).toBe(true);
});

test("displays foreign queued messages read-only with disabled action buttons", async () => {
	const app = await open("./chat-pending-queue-fixture.tsx", {
		platform: "macos",
		width: 640,
		height: 480,
	});

	await app.press("id:fixture-inject-remote");
	await app.waitFor("id:chat-pending-queue");
	expect(app.shows("id:chat-pending-item-0 >> text:from remote")).toBe(true);

	// Disabled buttons reject presses and do not trigger clear_queue or mutate the queue.
	let editError = "";
	try {
		await app.press("id:chat-pending-edit-0");
	} catch (error) {
		editError = String(error);
	}
	expect(editError).toContain("disabled");

	let sendNowError = "";
	try {
		await app.press("id:chat-pending-send-now-0");
	} catch (error) {
		sendNowError = String(error);
	}
	expect(sendNowError).toContain("disabled");

	expect(app.shows("text:idle")).toBe(true);
	expect(app.shows("id:chat-pending-item-0 >> text:from remote")).toBe(true);
});
