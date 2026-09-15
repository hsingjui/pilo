export type AppErrorCode =
	| "pi_not_found"
	| "connection_unavailable"
	| "authentication_failed"
	| "path_not_found"
	| "timeout"
	| "session_unavailable"
	| "runtime_failed"
	| "unknown";

export type AppErrorArea =
	| "connection"
	| "runtime"
	| "session"
	| "model"
	| "extension"
	| "unknown";

export type AppErrorAction = "retry" | "reconnect" | "settings" | "none";

export type AppError = {
	code: AppErrorCode;
	area: AppErrorArea;
	action: AppErrorAction;
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

function appError(
	code: AppErrorCode,
	area: AppErrorArea,
	action: AppErrorAction,
	message: string,
	detail: string,
	retryable: boolean,
): AppError {
	return { code, area, action, message, detail, retryable };
}

export function toAppError(error: unknown): AppError {
	const detail = rawErrorMessage(error);
	const text = detail.toLowerCase();
	if (
		text.includes("pi executable") ||
		text.includes("pi was not found") ||
		text.includes("not found in path")
	) {
		return appError(
			"pi_not_found",
			"runtime",
			"settings",
			"未检测到可用的 Pi。请确认当前环境已安装 Pi，然后重试。",
			detail,
			false,
		);
	}
	const looksLikeSshAuthenticationFailure =
		(text.includes("ssh") ||
			text.includes("publickey") ||
			text.includes("sshpass")) &&
		(text.includes("permission denied") ||
			text.includes("authentication") ||
			text.includes("password"));
	if (looksLikeSshAuthenticationFailure) {
		return appError(
			"authentication_failed",
			"connection",
			"reconnect",
			"连接认证失败。请检查密码或私钥后重试。",
			detail,
			true,
		);
	}
	if (
		text.includes("timed out") ||
		text.includes("timeout") ||
		text.includes("请求超时")
	) {
		return appError(
			"timeout",
			"runtime",
			"retry",
			"请求超时。请重试。",
			detail,
			true,
		);
	}
	if (
		text.includes("no such file") ||
		(text.includes("path") && text.includes("not found"))
	) {
		return appError(
			"path_not_found",
			"session",
			"none",
			"目标路径不存在或不可访问。请确认路径后重试。",
			detail,
			false,
		);
	}
	if (
		text.includes("session") &&
		(text.includes("not running") ||
			text.includes("closing") ||
			text.includes("changed while history"))
	) {
		return appError(
			"session_unavailable",
			"session",
			"retry",
			"会话运行环境当前不可用。请重试。",
			detail,
			true,
		);
	}
	if (
		text.includes("ssh") ||
		text.includes("wsl") ||
		text.includes("server disconnected") ||
		text.includes("connection refused") ||
		text.includes("connection reset")
	) {
		return appError(
			"connection_unavailable",
			"connection",
			"reconnect",
			"连接当前不可用。请检查连接设置后重试。",
			detail,
			true,
		);
	}
	if (text.includes("model") || text.includes("provider")) {
		return appError("unknown", "model", "retry", detail, detail, true);
	}
	if (text.includes("extension") || text.includes("mcp")) {
		return appError("unknown", "extension", "retry", detail, detail, true);
	}
	if (
		text.includes("pi runtime") ||
		text.includes("pi rpc") ||
		text.includes("process")
	) {
		return appError(
			"runtime_failed",
			"runtime",
			"retry",
			"Pi Runtime 运行失败。请重试，仍失败请查看诊断。",
			detail,
			true,
		);
	}
	return appError("unknown", "unknown", "retry", detail, detail, true);
}

export function appErrorActionLabel(error: AppError): string | null {
	switch (error.action) {
		case "retry":
			return "重试";
		case "reconnect":
			return "重新连接";
		case "settings":
			return "检查设置";
		case "none":
			return null;
	}
}

/** 面向用户的错误文案：只说能做什么，原始异常留在 AppError.detail 里。 */
export function userErrorMessage(error: unknown): string {
	return toAppError(error).message;
}
