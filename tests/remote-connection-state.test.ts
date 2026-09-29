import assert from "node:assert/strict";
import test from "node:test";

import {
	remoteConnectionLabelKey,
	resolveRemoteConnectionState,
} from "../src/remote/remote-connection-state.ts";

test("a live socket takes precedence over navigator online hints", () => {
	assert.equal(resolveRemoteConnectionState(false, true), "connected");
	assert.equal(resolveRemoteConnectionState(true, true), "connected");
});

test("a disconnected socket uses the browser hint to distinguish offline", () => {
	assert.equal(resolveRemoteConnectionState(false, false), "offline");
	assert.equal(resolveRemoteConnectionState(true, false), "reconnecting");
});

test("connection states map to the shared Remote status copy", () => {
	assert.equal(
		remoteConnectionLabelKey("connected"),
		"settings.remoteConnected",
	);
	assert.equal(remoteConnectionLabelKey("offline"), "settings.remoteOffline");
	assert.equal(
		remoteConnectionLabelKey("reconnecting"),
		"settings.remoteReconnecting",
	);
});
