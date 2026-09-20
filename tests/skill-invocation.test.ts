import assert from "node:assert/strict";
import test from "node:test";

import {
	parseSkillInvocation,
	skillInvocationSummary,
} from "../src/lib/skill-invocation.ts";

const expandedText = [
	'<skill name="animate" location="/root/.agents/skills/animate/SKILL.md">',
	"References are relative to /root/.agents/skills/animate.",
	"",
	"# Animate",
	"",
	"Build an animation from scratch.",
	"</skill>",
].join("\n");

test("parses the expanded skill block emitted by Pi", () => {
	assert.deepEqual(parseSkillInvocation(expandedText), {
		name: "animate",
		location: "/root/.agents/skills/animate/SKILL.md",
		additionalInstructions: "",
		content:
			"References are relative to /root/.agents/skills/animate.\n\n# Animate\n\nBuild an animation from scratch.",
		form: "expanded",
	});
});

test("expanded skill block keeps trailing user instructions", () => {
	const text = `${expandedText}\n\n给按钮加个过渡`;
	assert.deepEqual(parseSkillInvocation(text), {
		name: "animate",
		location: "/root/.agents/skills/animate/SKILL.md",
		additionalInstructions: "给按钮加个过渡",
		content:
			"References are relative to /root/.agents/skills/animate.\n\n# Animate\n\nBuild an animation from scratch.",
		form: "expanded",
	});
});

test("parses the compact command typed in the composer", () => {
	assert.deepEqual(parseSkillInvocation("/skill:animate"), {
		name: "animate",
		location: null,
		additionalInstructions: "",
		content: null,
		form: "compact",
	});
	assert.deepEqual(
		parseSkillInvocation("/skill:better-ui 审查这个页面的可访问性"),
		{
			name: "better-ui",
			location: null,
			additionalInstructions: "审查这个页面的可访问性",
			content: null,
			form: "compact",
		},
	);
});

test("regular messages are not mistaken for skill invocations", () => {
	assert.equal(parseSkillInvocation("普通消息"), null);
	assert.equal(parseSkillInvocation("/compact 压缩上下文"), null);
	assert.equal(parseSkillInvocation("/skill:"), null);
	assert.equal(
		parseSkillInvocation('开头不是 skill 标签 <skill name="x">'),
		null,
	);
});

test("incomplete expanded block is not treated as a skill invocation", () => {
	assert.equal(parseSkillInvocation('<skill name="animate">写入一半'), null);
});

test("summary renders the compact command plus instructions", () => {
	assert.equal(skillInvocationSummary(expandedText), "/skill:animate");
	assert.equal(
		skillInvocationSummary(`${expandedText}\n\n给按钮加个过渡`),
		"/skill:animate 给按钮加个过渡",
	);
	assert.equal(
		skillInvocationSummary("/skill:animate 给按钮加个过渡"),
		"/skill:animate 给按钮加个过渡",
	);
	assert.equal(skillInvocationSummary("普通消息"), null);
});
