import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
	HOST_API_METHOD_META,
	HOST_API_PROTOCOL_VERSION,
	type HostApiMethodSpec,
} from "@shared/api/host-methods";

describe("Host API method table parity", () => {
	it("matches Rust-generated host-methods.json in names, scopes, kinds, and protocol version", () => {
		const raw = readFileSync(
			new URL("../../shared/api/host-methods.json", import.meta.url),
			"utf8",
		);
		const generated = JSON.parse(raw) as {
			protocolVersion: string;
			methods: HostApiMethodSpec[];
		};

		assert.equal(generated.protocolVersion, HOST_API_PROTOCOL_VERSION);

		const generatedByName = new Map(
			generated.methods.map((spec) => [spec.name, spec]),
		);
		assert.equal(
			generatedByName.size,
			generated.methods.length,
			"generated method names must be unique",
		);

		const tsNames = Object.keys(HOST_API_METHOD_META).toSorted();
		const rustNames = [...generatedByName.keys()].toSorted();
		assert.deepEqual(tsNames, rustNames);

		for (const [name, tsMeta] of Object.entries(HOST_API_METHOD_META)) {
			const rustSpec = generatedByName.get(name);
			assert.ok(rustSpec, `missing Rust spec for ${name}`);
			assert.equal(
				tsMeta.scope,
				rustSpec.scope,
				`scope mismatch for method ${name}`,
			);
			assert.equal(
				tsMeta.kind,
				rustSpec.kind,
				`kind mismatch for method ${name}`,
			);
		}
	});
});
