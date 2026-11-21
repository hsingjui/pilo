import assert from "node:assert/strict";
import test from "node:test";

import { pairingTargetAddress } from "../../web/remote/remote-pairing-model.ts";

const lan = { id: "lan", name: "", baseUrl: "http://192.168.1.5:47653" };
const publicAddress = {
	id: "public",
	name: "",
	baseUrl: "https://example.com",
};

test("a single-address scan automatically selects the current origin", () => {
	assert.equal(pairingTargetAddress([lan], null, false, lan.baseUrl), lan);
	assert.equal(
		pairingTargetAddress([publicAddress], null, false, publicAddress.baseUrl),
		publicAddress,
	);
});

test("a multi-address scan still waits for explicit address selection", () => {
	assert.equal(
		pairingTargetAddress([lan, publicAddress], "lan", false, lan.baseUrl),
		null,
	);
});

test("target pages retain explicit address selection", () => {
	assert.equal(
		pairingTargetAddress(
			[lan, publicAddress],
			"public",
			true,
			publicAddress.baseUrl,
		),
		publicAddress,
	);
	assert.equal(pairingTargetAddress([lan], "lan", true, lan.baseUrl), lan);
	assert.throws(
		() => pairingTargetAddress([lan], "unknown", true, lan.baseUrl),
		/REMOTE_PAIRING_INVALID_LINK/,
	);
});

test("automatic and explicit selection never authenticate a different origin", () => {
	assert.throws(
		() => pairingTargetAddress([lan], null, false, publicAddress.baseUrl),
		/REMOTE_PAIRING_INVALID_LINK/,
	);
	assert.throws(
		() =>
			pairingTargetAddress(
				[lan, publicAddress],
				"lan",
				true,
				publicAddress.baseUrl,
			),
		/REMOTE_PAIRING_INVALID_LINK/,
	);
});
