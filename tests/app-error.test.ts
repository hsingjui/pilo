import assert from "node:assert/strict";
import test from "node:test";

import { toAppError, userErrorMessage } from "../src/lib/app-error.ts";

test("normalizes Pi lookup failures", () => {
	const error = toAppError("Pi executable was not found in PATH");
	assert.equal(error.code, "pi_not_found");
	assert.equal(error.retryable, false);
	assert.match(
		userErrorMessage("Pi executable was not found in PATH"),
		/未检测到可用的 Pi/,
	);
});

test("normalizes connection and timeout failures as retryable", () => {
	const connection = toAppError("SSH connection refused");
	assert.equal(connection.code, "connection_unavailable");
	assert.equal(connection.area, "connection");
	assert.equal(connection.action, "reconnect");
	assert.equal(toAppError("Pi RPC request timed out").code, "timeout");
	assert.equal(toAppError("Pi RPC request timed out").retryable, true);
});

test("only classifies SSH-shaped authentication failures as connection auth", () => {
	assert.equal(
		toAppError("Permission denied (publickey,password)").code,
		"authentication_failed",
	);
	assert.equal(
		toAppError("open /root/secret: permission denied").code,
		"unknown",
	);
	assert.equal(toAppError("provider authentication failed").code, "unknown");
});

test("keeps unknown backend errors visible", () => {
	assert.equal(
		userErrorMessage(new Error("custom backend failure")),
		"custom backend failure",
	);
});
