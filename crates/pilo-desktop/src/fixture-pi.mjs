#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

function widget(key, lines) {
	print({
		type: "extension_ui_request",
		id: key,
		method: "setWidget",
		widgetKey: key,
		widgetLines: lines,
	});
}

const args = process.argv.slice(2);
const enhancement = args.some((arg) =>
	arg.includes("You rewrite a user's draft prompt"),
);
let selectedModel = null;

for await (const line of createInterface({ input: process.stdin })) {
	if (!line.trim()) continue;
	const command = JSON.parse(line);
	const kind = command.type;
	const prediction =
		kind === "prompt" && command.message.startsWith("/pilo-next-prompt ");
	let data = "probe" in command ? command.probe : {};
	if (kind === "get_available_models") {
		data = {
			models: [
				{
					provider: "fixture",
					id: "naming",
					name: "Naming Model",
					reasoning: false,
				},
			],
		};
		if (enhancement) {
			for (const id of ["rewrite", "chat"]) {
				data.models.push({ provider: "fixture", id });
			}
		}
	} else if (kind === "set_model") {
		selectedModel = command.modelId;
		data = { provider: command.provider, id: command.modelId };
	} else if (prediction) {
		data = JSON.parse(command.message.slice(command.message.indexOf(" ") + 1));
	}
	if (command.id === "fixture-shutdown") {
		writeFileSync("fixture-pi.pid", String(process.pid));
	}
	print({
		type: "response",
		id: command.id ?? null,
		command: kind,
		success: true,
		data,
	});
	if (kind === "get_state" && command.id === "fixture-next-prompt-ready") {
		widget("pilo.next-prompt.ready.v1", ["ready"]);
	}
	if (prediction && !data.cancel) {
		const result = {
			requestId: data.requestId,
			sessionId: data.sessionId,
			revision: data.revision,
			leafId: "fixture-leaf",
			text: "What comes next?",
			status: "ready",
		};
		widget("pilo.next-prompt.v1", [JSON.stringify(result)]);
	}
	if (kind === "prompt" && command.id === "fixture-transcript-turn") {
		for (const event of [
			{ type: "agent_start" },
			{
				type: "message_start",
				message: {
					role: "user",
					content: [{ type: "text", text: command.message }],
				},
			},
			{ type: "message_start", message: { role: "assistant" } },
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "partial reply" },
			},
		]) {
			print(event);
		}
	}
	if (kind === "prompt" && !command.id) {
		let reply = `"${command.message}"\nignored`;
		let stopReason = "stop";
		let errorMessage = null;
		if (enhancement) {
			if (
				!["--no-session", "--no-tools", "--no-extensions"].every((flag) =>
					args.includes(flag),
				)
			) {
				stopReason = "error";
				errorMessage = "enhancement must not load a session or resources";
			} else if (command.message === "fail generation") {
				stopReason = "error";
				errorMessage = "fixture generation failed";
			} else if (command.message === "empty rewrite") {
				reply = '" "';
			} else {
				reply = `\`\`\`text\n"${selectedModel}: ${command.message}"\n\`\`\``;
			}
		}
		const message = {
			role: "assistant",
			content: [{ type: "text", text: reply }],
			stopReason,
		};
		if (errorMessage !== null) message.errorMessage = errorMessage;
		print({ type: "message_end", message });
		print({ type: "agent_settled" });
	}
}
