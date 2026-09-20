export type SkillInvocation = {
	/** Skill 名称，即斜杠命令 /skill:<name> 的 name 部分。 */
	name: string;
	/** SKILL.md 路径，仅展开形态携带。 */
	location: string | null;
	/** Skill 块之后由用户附带的补充指令。 */
	additionalInstructions: string;
	/** 展开形态下的 Skill 正文（去掉包裹标签）。 */
	content: string | null;
	/**
	 * expanded = Pi 回显 / JSONL 中的 <skill> 块；
	 * compact = 发送后本地回显的 /skill:<name> 原文。
	 */
	form: "expanded" | "compact";
};

const COMPACT_COMMAND_PATTERN = /^\/skill:([^\s/]+)(?:[ \t]+([\s\S]*))?$/;
const OPENING_TAG_PATTERN = /^<skill name="([^"]+)"(?: location="([^"]*)")?>\n/;
const CLOSING_TAG = "\n</skill>";

/**
 * 识别一条用户消息是否是 skill 斜杠命令调用。
 *
 * Pi 收到 `/skill:<name>` 后会展开成
 * `<skill name="..." location="...">…</skill>` 块（可再接用户补充指令），
 * 回显与 JSONL 中保存的都是展开后的文本；本地刚发送的消息则还是紧凑原文。
 */
export function parseSkillInvocation(text: string): SkillInvocation | null {
	if (!text) return null;

	const compact = text.match(COMPACT_COMMAND_PATTERN);
	if (compact) {
		return {
			name: compact[1],
			location: null,
			additionalInstructions: compact[2]?.trim() ?? "",
			content: null,
			form: "compact",
		};
	}

	const opening = text.match(OPENING_TAG_PATTERN);
	if (opening) {
		const closingIndex = text.indexOf(CLOSING_TAG, opening[0].length);
		if (closingIndex < 0) return null;
		const afterClosing = closingIndex + CLOSING_TAG.length;
		return {
			name: opening[1],
			location: opening[2] ?? null,
			additionalInstructions: text
				.slice(afterClosing)
				.replace(/^\n+/, "")
				.trim(),
			content: text.slice(opening[0].length, closingIndex),
			form: "expanded",
		};
	}

	return null;
}

/** 生成 `/skill:<name> 补充指令` 形式的单行摘要，供大纲标题等紧凑展示使用。 */
export function skillInvocationSummary(text: string): string | null {
	const invocation = parseSkillInvocation(text);
	if (!invocation) return null;
	return invocation.additionalInstructions
		? `/skill:${invocation.name} ${invocation.additionalInstructions}`
		: `/skill:${invocation.name}`;
}
