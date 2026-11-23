import assert from "node:assert/strict";
import test from "node:test";

import {
	capturePairingBootFromUrl,
	isRemotePairingUrl,
	pairingReturnUrl,
	pairingTargetAddress,
	pairingTargetUrl,
	parseRemotePairResponse,
	parseRemotePairingInfo,
	type PairingStorage,
} from "../../shared/remote-pairing.ts";

const lan = { id: "lan", name: "", baseUrl: "http://192.168.1.5:47653" };
const publicAddress = {
	id: "public",
	name: "",
	baseUrl: "https://example.com",
};
const VALID_SECRET = "a".repeat(43);

function memoryStorage(): PairingStorage {
	const map = new Map<string, string>();
	return {
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => map.set(key, value),
		removeItem: (key) => {
			map.delete(key);
		},
	};
}

test("detects pairing URLs across pathname, hash and query", () => {
	assert.equal(isRemotePairingUrl("http://192.168.1.5:47653/pair"), true);
	assert.equal(
		isRemotePairingUrl(`http://192.168.1.5:47653/pair#pair=${VALID_SECRET}`),
		true,
	);
	assert.equal(
		isRemotePairingUrl("https://example.com/pair/complete#pair=abc"),
		true,
	);
	assert.equal(isRemotePairingUrl("http://192.168.1.5:47653/?pair=abc"), true);
	assert.equal(isRemotePairingUrl("http://192.168.1.5:47653/"), false);
	assert.equal(isRemotePairingUrl("http://192.168.1.5:47653/chat/1"), false);
	assert.equal(isRemotePairingUrl(null), false);
});

test("capturePairingBootFromUrl stores context and scrubs secret from URL", () => {
	const storage = memoryStorage();
	const replaced: string[] = [];
	const boot = capturePairingBootFromUrl(
		`http://192.168.1.5:47653/pair#pair=${VALID_SECRET}`,
		storage,
		(pathname) => replaced.push(pathname),
		1_000,
	);
	assert.equal(boot.error, null);
	assert.equal(boot.target, false);
	assert.equal(boot.context?.secret, VALID_SECRET);
	assert.deepEqual(replaced, ["/pair"]);

	const targetHref = pairingTargetUrl(publicAddress, boot.context!, "lan");
	assert.match(targetHref, /^https:\/\/example\.com\/pair\/complete#/);
	assert.equal(pairingReturnUrl(lan), "http://192.168.1.5:47653/pair");

	const targetReplaced: string[] = [];
	const targetBoot = capturePairingBootFromUrl(
		targetHref,
		memoryStorage(),
		(pathname) => targetReplaced.push(pathname),
		2_000,
	);
	assert.equal(targetBoot.error, null);
	assert.equal(targetBoot.target, true);
	assert.equal(targetBoot.context?.addressId, "public");
	assert.equal(targetBoot.context?.entryAddressId, "lan");
	assert.deepEqual(targetReplaced, ["/pair/complete"]);
});

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

test("validates pairing info and pair exchange payloads", () => {
	const info = parseRemotePairingInfo({
		addresses: [{ ...lan, issued: false }],
		expiresAtMs: 5_000,
		remainingUses: 1,
	});
	assert.equal(info.addresses.length, 1);
	assert.throws(
		() =>
			parseRemotePairingInfo({
				addresses: [{ ...lan, baseUrl: "ftp://example.com", issued: false }],
				expiresAtMs: 5_000,
				remainingUses: 1,
			}),
		/REMOTE_PAIRING_INVALID_RESPONSE/,
	);
	const paired = parseRemotePairResponse(
		{
			token: VALID_SECRET,
			device: { id: "dev-1", expiresAtMs: 10_000 },
		},
		1_000,
	);
	assert.equal(paired.token, VALID_SECRET);
	assert.equal(paired.expiresAtMs, 10_000);
});
