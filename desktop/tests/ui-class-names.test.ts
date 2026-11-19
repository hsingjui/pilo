import { expect, test } from "nsh/test";
import { classNames } from "../ui/class-names";

test("classNames joins classes in order and omits empty optional values", () => {
	expect(classNames("base", undefined, false, "", null, "custom")).toBe(
		"base custom",
	);
	expect(classNames()).toBe("");
});
