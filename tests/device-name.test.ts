import assert from "node:assert/strict";
import test from "node:test";

import { describeDevice } from "../src/lib/device-name.ts";

test("Android UA resolves to model and browser", () => {
	assert.equal(
		describeDevice(
			"Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A.240205.004) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
		),
		"Pixel 8 · Chrome",
	);
});

test("iOS UA falls back to OS because Safari hides the model", () => {
	assert.equal(
		describeDevice(
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
		),
		"iOS · Safari",
	);
});

test("desktop UA resolves to OS and browser", () => {
	assert.equal(
		describeDevice(
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
		),
		"Windows · Microsoft Edge",
	);
});

test("empty UA yields an empty name so the host can apply its default", () => {
	assert.equal(describeDevice(""), "");
	assert.equal(describeDevice("   "), "");
});

test("unrecognized UA is bounded to 80 characters", () => {
	const unknown = "z".repeat(200);
	assert.equal(describeDevice(unknown).length, 80);
});
