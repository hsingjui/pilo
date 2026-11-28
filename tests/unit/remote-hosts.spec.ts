import assert from "node:assert/strict";
import test from "node:test";

import {
	desktopDeviceName,
	hasRemoteScope,
	isPlaintextRemoteAddress,
	isPrivateLanHost,
	parseDesktopPairingLink,
	parseRemoteHostRecords,
	REMOTE_HOST_OFFLINE_AFTER_MS,
	remoteHostAddressOrder,
	remoteHostConnectOrder,
	resolveRemoteHostStatus,
	serializeRemoteHostRecords,
	upsertRemoteHostRecord,
	type RemoteHostRecord,
} from "../../shared/remote-hosts.ts";

const record: RemoteHostRecord = {
	hostId: "host-b",
	name: "B",
	addresses: [
		{ id: "lan", name: "LAN", baseUrl: "http://192.168.1.2:7890" },
		{ id: "ts", name: "Tailscale", baseUrl: "http://100.64.0.2:7890" },
		{ id: "public", name: "Public", baseUrl: "https://b.example.com" },
	],
	preferredAddressId: "ts",
	deviceId: "device-1",
	scopes: "chat,workspace",
	platform: "linux",
};

test("records round-trip and malformed or duplicate entries are skipped", () => {
	const raw = serializeRemoteHostRecords([record]);
	assert.deepEqual(parseRemoteHostRecords(raw), [record]);
	const mixed = JSON.stringify([
		record,
		{ ...record, name: "duplicate" },
		{ hostId: "", name: "x", deviceId: "d", addresses: [] },
		{
			...record,
			hostId: "host-c",
			preferredAddressId: "missing",
			scopes: "admin",
			addresses: [
				{ id: "bad", name: "Bad", baseUrl: "ftp://c" },
				{ id: "ok", name: "OK", baseUrl: "http://10.0.0.3:7890/" },
			],
		},
	]);
	const parsed = parseRemoteHostRecords(mixed);
	assert.equal(parsed.length, 2);
	assert.equal(parsed[0].name, "B");
	assert.deepEqual(parsed[1].addresses, [
		{ id: "ok", name: "OK", baseUrl: "http://10.0.0.3:7890" },
	]);
	assert.equal(parsed[1].preferredAddressId, "ok");
	assert.equal(parsed[1].scopes, "chat");
	assert.deepEqual(parseRemoteHostRecords("not json"), []);
	assert.deepEqual(parseRemoteHostRecords(null), []);
});

test("connecting skips plaintext fallbacks the user did not agree to", () => {
	const lanFirst = { ...record, preferredAddressId: "lan" };
	assert.deepEqual(
		remoteHostConnectOrder(lanFirst).map(({ id }) => id),
		["lan", "public"],
	);
	assert.deepEqual(
		remoteHostConnectOrder({ ...lanFirst, plaintextAddressIds: ["ts"] }).map(
			({ id }) => id,
		),
		["lan", "ts", "public"],
	);
	// The preferred address was confirmed when pairing.
	assert.deepEqual(
		remoteHostConnectOrder(record).map(({ id }) => id),
		["ts", "lan", "public"],
	);
	const raw = serializeRemoteHostRecords([
		{ ...record, plaintextAddressIds: ["ts", "gone"] },
	]);
	assert.deepEqual(parseRemoteHostRecords(raw)[0]?.plaintextAddressIds, ["ts"]);
});

test("upsert replaces a Host in place and appends a new one", () => {
	const renamed = { ...record, name: "B2" };
	assert.deepEqual(upsertRemoteHostRecord([record], renamed), [renamed]);
	const other = { ...record, hostId: "host-c" };
	assert.deepEqual(upsertRemoteHostRecord([record], other), [record, other]);
});

test("connections try the preferred address first, then the rest in order", () => {
	assert.deepEqual(
		remoteHostAddressOrder(record).map(({ id }) => id),
		["ts", "lan", "public"],
	);
	assert.deepEqual(
		remoteHostAddressOrder({ ...record, preferredAddressId: "gone" }).map(
			({ id }) => id,
		),
		["lan", "ts", "public"],
	);
});

test("plain http outside private LAN ranges needs a warning", () => {
	for (const host of [
		"localhost",
		"127.0.0.1",
		"10.1.2.3",
		"172.16.0.1",
		"172.31.255.255",
		"192.168.0.10",
		"169.254.1.1",
		"[::1]",
		"[fd12::1]",
		"[fe80::1]",
		"pilo.local",
	]) {
		assert.equal(isPrivateLanHost(host), true, host);
		assert.equal(isPlaintextRemoteAddress(`http://${host}:7890`), false, host);
	}
	for (const url of [
		"http://172.32.0.1:7890",
		"http://100.64.0.2:7890",
		"http://8.8.8.8",
		"http://b.example.com",
	]) {
		assert.equal(isPlaintextRemoteAddress(url), true, url);
	}
	assert.equal(isPlaintextRemoteAddress("https://8.8.8.8"), false);
	assert.equal(isPlaintextRemoteAddress("not a url"), false);
});

test("pairing links carry the entry origin, secret and optional address", () => {
	const secret = "A".repeat(43);
	assert.deepEqual(
		parseDesktopPairingLink(` http://192.168.1.2:7890/pair#pair=${secret} `),
		{ entryOrigin: "http://192.168.1.2:7890", secret, addressId: null },
	);
	assert.deepEqual(
		parseDesktopPairingLink(
			`https://b.example.com/pair/complete#pair=${secret}&address=public`,
		),
		{ entryOrigin: "https://b.example.com", secret, addressId: "public" },
	);
	for (const bad of [
		"",
		"b.example.com/pair#pair=x",
		`https://b.example.com/other#pair=${secret}`,
		"https://b.example.com/pair#pair=short",
		`ftp://b.example.com/pair#pair=${secret}`,
	]) {
		assert.throws(
			() => parseDesktopPairingLink(bad),
			/REMOTE_PAIRING_INVALID_LINK/,
		);
	}
});

test("the device name joins the machine name and Pilo Desktop", () => {
	assert.equal(desktopDeviceName(" Mac  mini "), "Mac mini · Pilo Desktop");
	assert.equal(desktopDeviceName(null), "Pilo Desktop");
	assert.equal(desktopDeviceName(""), "Pilo Desktop");
});

test("a reconnect that does not come back shows offline", () => {
	assert.equal(resolveRemoteHostStatus("connected", 99_999), "connected");
	assert.equal(resolveRemoteHostStatus("connecting", 0), "connecting");
	assert.equal(
		resolveRemoteHostStatus("reconnecting", REMOTE_HOST_OFFLINE_AFTER_MS - 1),
		"connecting",
	);
	assert.equal(
		resolveRemoteHostStatus("reconnecting", REMOTE_HOST_OFFLINE_AFTER_MS),
		"offline",
	);
	assert.equal(resolveRemoteHostStatus("offline", 0), "offline");
	assert.equal(resolveRemoteHostStatus("unauthorized", 0), "unauthorized");
	assert.equal(resolveRemoteHostStatus("incompatible", 0), "incompatible");
});

test("scopes are matched as a comma list", () => {
	assert.equal(hasRemoteScope("chat", "chat"), true);
	assert.equal(hasRemoteScope("chat", "workspace"), false);
	assert.equal(hasRemoteScope("chat,workspace", "workspace"), true);
	assert.equal(hasRemoteScope(null, "chat"), false);
});
