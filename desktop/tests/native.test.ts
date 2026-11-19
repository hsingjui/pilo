import { expect, test } from "nsh/test";
import { AppInfo } from "app/native";

test("the native shell exposes its crate version", () => {
	expect(AppInfo.version()).toBe("0.1.0");
});
