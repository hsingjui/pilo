import assert from "node:assert/strict";
import test from "node:test";
import { copyText } from "../../src/lib/copy-text.ts";

function set(name, value) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

test("copyText preserves clipboard errors and supports insecure contexts", async (t) => {
	const names = ["navigator", "document", "window", "HTMLElement"];
	const descriptors = names.map((name) =>
		Object.getOwnPropertyDescriptor(globalThis, name),
	);
	t.after(() =>
		names.forEach((name, index) => {
			if (descriptors[index])
				Object.defineProperty(globalThis, name, descriptors[index]);
			else delete globalThis[name];
		}),
	);
	await t.test("modern clipboard accepts normal and empty text", async () => {
		const values = [];
		set("navigator", {
			clipboard: { writeText: async (value) => values.push(value) },
		});
		await copyText("hello");
		await copyText("");
		assert.deepEqual(values, ["hello", ""]);
	});
	await t.test(
		"permission rejection propagates to the localized error handler",
		async () => {
			set("navigator", {
				clipboard: {
					writeText: async () => {
						throw new Error("Denied");
					},
				},
			});
			await assert.rejects(copyText("hello"), /Denied/);
		},
	);
	await t.test(
		"missing clipboard fallback restores focus and selection",
		async () => {
			let succeeds = true;
			const calls = [];
			class Element {
				focus() {
					calls.push("focus");
				}
			}
			const field = Object.assign(new Element(), {
				style: {},
				select() {
					calls.push("select");
				},
				remove() {
					calls.push("remove");
				},
			});
			set("HTMLElement", Element);
			set("navigator", {});
			set("window", {
				getSelection: () => ({
					anchorNode: { isConnected: true },
					focusNode: { isConnected: true },
					setBaseAndExtent() {
						calls.push("restore selection");
					},
				}),
			});
			set("document", {
				activeElement: new Element(),
				createElement: () => field,
				body: {
					append() {
						calls.push("append");
					},
				},
				execCommand(command) {
					assert.equal(command, "copy");
					return succeeds;
				},
			});
			await copyText("fallback");
			assert.equal(field.value, "fallback");
			assert.deepEqual(calls, [
				"append",
				"focus",
				"select",
				"remove",
				"focus",
				"restore selection",
			]);
			calls.length = 0;
			succeeds = false;
			await assert.rejects(copyText("fallback"), /Copy failed/);
			assert.deepEqual(calls, [
				"append",
				"focus",
				"select",
				"remove",
				"focus",
				"restore selection",
			]);
		},
	);
});
