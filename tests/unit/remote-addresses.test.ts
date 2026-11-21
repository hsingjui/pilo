import assert from "node:assert/strict";
import test from "node:test";

import {
	remoteAddressConfig,
	sameAddressList,
} from "../../shared/remote-addresses.ts";

const lan = { id: "lan", name: "", baseUrl: "http://192.168.1.5:47653" };
const publicAddress = {
	id: "public",
	name: "Existing name",
	baseUrl: "https://example.com",
};

test("defaults the QR entry to LAN without discarding existing addresses", () => {
	assert.deepEqual(remoteAddressConfig([lan, publicAddress], "public"), {
		addresses: [lan, publicAddress],
		entryAddressId: "lan",
	});
});

test("keeps new empty rows out of the persisted pairing configuration", () => {
	assert.deepEqual(
		remoteAddressConfig([lan, { id: "draft", name: "", baseUrl: "  " }], "lan"),
		{ addresses: [lan], entryAddressId: "lan" },
	);
});

test("trims input while preserving address IDs and legacy names", () => {
	assert.deepEqual(
		remoteAddressConfig(
			[lan, { ...publicAddress, baseUrl: " https://example.com  " }],
			"lan",
		),
		{ addresses: [lan, publicAddress], entryAddressId: "lan" },
	);
});

test("defaults LAN and loopback hosts to HTTP, public hosts to HTTPS", () => {
	for (const [input, expected] of [
		["example.com", "https://example.com"],
		[" example.com:8443 ", "https://example.com:8443"],
		["192.168.1.5:47653", "http://192.168.1.5:47653"],
		["localhost:47653", "http://localhost:47653"],
		["//example.com", "https://example.com"],
		["http://example.com", "http://example.com"],
		["https://example.com", "https://example.com"],
		["ftp://example.com", "ftp://example.com"],
	] as const) {
		assert.equal(
			remoteAddressConfig([{ ...publicAddress, baseUrl: input }], "public")
				.addresses[0].baseUrl,
			expected,
		);
	}
});

test("uses a remaining address if a legacy list has no LAN entry", () => {
	assert.equal(
		remoteAddressConfig([publicAddress], "removed").entryAddressId,
		"public",
	);
	assert.deepEqual(remoteAddressConfig([], "removed"), {
		addresses: [],
		entryAddressId: "",
	});
});

test("compares address lists by id, URL and name instead of serialization", () => {
	assert.equal(
		sameAddressList([lan, publicAddress], [lan, publicAddress]),
		true,
	);
	assert.equal(
		sameAddressList(
			[lan, publicAddress],
			[lan, { ...publicAddress, name: "x" }],
		),
		false,
	);
	assert.equal(
		sameAddressList(
			[lan, publicAddress],
			[lan, { ...publicAddress, baseUrl: "https://other.example" }],
		),
		false,
	);
	assert.equal(sameAddressList([lan], [lan, publicAddress]), false);
	assert.equal(
		sameAddressList([lan, publicAddress], [publicAddress, lan]),
		false,
	);
});
