import { i18n } from "../i18n/index.ts";

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

export type AppErrorMessageKey =
	| "errors.requestFailed"
	| "errors.piNotFound"
	| "errors.authenticationFailed"
	| "errors.timeout"
	| "errors.pathNotFound"
	| "errors.sessionUnavailable"
	| "errors.connectionUnavailable"
	| "errors.runtimeFailed";

export type AppError = {
	code: AppErrorCode;
	area: AppErrorArea;
	action: AppErrorAction;
	messageKey: AppErrorMessageKey | null;
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
	return "Request failed";
}

function appError(
	code: AppErrorCode,
	area: AppErrorArea,
	action: AppErrorAction,
	messageKey: AppErrorMessageKey | null,
	detail: string,
	retryable: boolean,
): AppError {
	return { code, area, action, messageKey, detail, retryable };
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
			"errors.piNotFound",
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
			"errors.authenticationFailed",
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
			"errors.timeout",
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
			"errors.pathNotFound",
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
			"errors.sessionUnavailable",
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
			"errors.connectionUnavailable",
			detail,
			true,
		);
	}
	if (text.includes("model") || text.includes("provider")) {
		return appError("unknown", "model", "retry", null, detail, true);
	}
	if (text.includes("extension") || text.includes("mcp")) {
		return appError("unknown", "extension", "retry", null, detail, true);
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
			"errors.runtimeFailed",
			detail,
			true,
		);
	}
	return appError("unknown", "unknown", "retry", null, detail, true);
}

export function appErrorMessage(error: AppError): string {
	return error.messageKey
		? i18n.t(error.messageKey)
		: (error.detail ?? i18n.t("errors.requestFailed"));
}

export function appErrorActionLabel(error: AppError): string | null {
	switch (error.action) {
		case "retry":
			return i18n.t("errors.retry");
		case "reconnect":
			return i18n.t("errors.reconnect");
		case "settings":
			return i18n.t("errors.checkSettings");
		case "none":
			return null;
	}
}

/** 面向用户的错误文案：只说能做什么，原始异常留在 AppError.detail 里。 */
export function userErrorMessage(error: unknown): string {
	return appErrorMessage(toAppError(error));
}
