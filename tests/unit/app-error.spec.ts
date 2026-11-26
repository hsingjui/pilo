import assert from "node:assert/strict";
import test from "node:test";

import { toAppError, userErrorMessage } from "../../shared/app-error.ts";

test("normalizes Pi lookup failures", () => {
	const error = toAppError("Pi executable was not found in PATH");
	assert.equal(error.code, "pi_not_found");
	assert.equal(error.retryable, false);
	assert.equal(error.messageKey, "errors.piNotFound");
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

test("classifies port-in-use, keychain, and masks raw OS/panic traces", () => {
	assert.equal(
		toAppError("SSH tunnel bind failed: Address already in use (os error 48)")
			.code,
		"port_in_use",
	);
	assert.equal(
		toAppError("SSH keychain error: errSecAuthFailed").code,
		"credential_store_unavailable",
	);
	const raw = toAppError("unexpected io failure (os error 13)");
	assert.equal(raw.code, "unknown");
	assert.equal(raw.messageKey, "errors.requestFailed");
});

test("uses word boundaries for OS error codes", () => {
	assert.equal(toAppError("open failed (os error 2)").code, "path_not_found");
	assert.equal(toAppError("invalid argument (os error 22)").code, "unknown");
	assert.equal(toAppError("too many open files (os error 24)").code, "unknown");
	assert.equal(
		toAppError("no space left on device (os error 28)").code,
		"unknown",
	);
});

test("distinguishes file size limits from RPC and model context limits", () => {
	assert.equal(
		toAppError("image attachment exceeds 10 MB").code,
		"file_too_large",
	);
	assert.equal(
		toAppError("File is too large to preview").code,
		"file_too_large",
	);
	assert.equal(
		toAppError("Pi stdout RPC line exceeds the byte limit").code,
		"runtime_failed",
	);
	assert.equal(
		toAppError("model prompt is too large and exceeds max token limit").code,
		"unknown",
	);
	assert.equal(
		toAppError("model prompt is too large and exceeds max token limit").area,
		"model",
	);
	const modelDbError = toAppError(
		"rusqlite error querying model_cache_keep_alive_settings (os error 5)",
	);
	assert.equal(modelDbError.area, "model");
	assert.equal(modelDbError.messageKey, "errors.requestFailed");
});
