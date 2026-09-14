export type AppErrorCode =
	| "pi_not_found"
	| "connection_unavailable"
	| "authentication_failed"
	| "path_not_found"
	| "timeout"
	| "session_unavailable"
	| "runtime_failed"
	| "unknown";

export type AppError = {
	code: AppErrorCode;
	message: string;
	detail?: string;
	retryable: boolean;
};

function rawErrorMessage(error: unknown): string {
	if (typeof error === "string" && error.trim()) return error.trim();
	if (error instanceof Error && error.message.trim())
		return error.message.trim();
	if (error && typeof error === "object") {
		const message = Reflect.get(error, "message");
		if (typeof message === "string" && message.trim()) return message.trim();
	}
	return "请求失败";
}

export function toAppError(error: unknown): AppError {
	const detail = rawErrorMessage(error);
	const text = detail.toLowerCase();
	if (
		text.includes("pi executable") ||
		text.includes("pi was not found") ||
		text.includes("not found in path")
	) {
		return {
			code: "pi_not_found",
			message: "未检测到可用的 Pi。请确认当前环境已安装 Pi，然后重试。",
			detail,
			retryable: false,
		};
	}
	const looksLikeSshAuthenticationFailure =
		(text.includes("ssh") ||
			text.includes("publickey") ||
			text.includes("sshpass")) &&
		(text.includes("permission denied") ||
			text.includes("authentication") ||
			text.includes("password"));
	if (looksLikeSshAuthenticationFailure) {
		return {
			code: "authentication_failed",
			message: "连接认证失败。请检查密码或私钥后重试。",
			detail,
			retryable: true,
		};
	}
	if (
		text.includes("timed out") ||
		text.includes("timeout") ||
		text.includes("请求超时")
	) {
		return {
			code: "timeout",
			message: "请求超时。请重试。",
			detail,
			retryable: true,
		};
	}
	if (
		text.includes("no such file") ||
		(text.includes("path") && text.includes("not found"))
	) {
		return {
			code: "path_not_found",
			message: "目标路径不存在或不可访问。请确认路径后重试。",
			detail,
			retryable: false,
		};
	}
	if (
		text.includes("session") &&
		(text.includes("not running") || text.includes("closing"))
	) {
		return {
			code: "session_unavailable",
			message: "会话运行环境当前不可用。请重试。",
			detail,
			retryable: true,
		};
	}
	if (
		text.includes("ssh") ||
		text.includes("wsl") ||
		text.includes("server disconnected") ||
		text.includes("connection refused") ||
		text.includes("connection reset")
	) {
		return {
			code: "connection_unavailable",
			message: "连接当前不可用。请检查连接设置后重试。",
			detail,
			retryable: true,
		};
	}
	if (
		text.includes("pi runtime") ||
		text.includes("pi rpc") ||
		text.includes("process")
	) {
		return {
			code: "runtime_failed",
			message: "Pi Runtime 运行失败。请重试，仍失败请查看诊断。",
			detail,
			retryable: true,
		};
	}
	// 未识别的错误没有中文映射，继续把原始文本作为最后手段展示。
	return {
		code: "unknown",
		message: detail,
		detail,
		retryable: true,
	};
}

/** 面向用户的错误文案：只说能做什么，原始异常留在 AppError.detail 里。 */
export function userErrorMessage(error: unknown): string {
	return toAppError(error).message;
}
