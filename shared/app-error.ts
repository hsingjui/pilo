import { t } from "./i18n/translate.ts";

export type AppErrorCode =
	| "pi_not_found"
	| "port_in_use"
	| "credential_store_unavailable"
	| "connection_unavailable"
	| "ssh_local_pi_resources_busy"
	| "authentication_failed"
	| "path_not_found"
	| "timeout"
	| "session_unavailable"
	| "file_too_large"
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
	| "errors.portInUse"
	| "errors.credentialStoreUnavailable"
	| "errors.sshLocalPiResourcesBusy"
	| "errors.authenticationFailed"
	| "errors.timeout"
	| "errors.pathNotFound"
	| "errors.sessionUnavailable"
	| "errors.fileTooLarge"
	| "errors.connectionUnavailable"
	| "errors.runtimeFailed"
	| "errors.stalledTurnInputClosed";

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

function looksLikeRawSystemError(detail: string): boolean {
	return (
		/\(os error \d+\)/i.test(detail) ||
		/panicked at /i.test(detail) ||
		/stack backtrace:/i.test(detail) ||
		/\b(rusqlite|sqlx|serde_json|tokio::|std::io::Error)\b/.test(detail) ||
		(detail.length > 260 && detail.includes("\n"))
	);
}

export function toAppError(error: unknown): AppError {
	const detail = rawErrorMessage(error);
	if (detail.includes("PILO_STALLED_TURN_INPUT_CLOSED")) {
		return appError(
			"session_unavailable",
			"session",
			"none",
			"errors.stalledTurnInputClosed",
			detail,
			false,
		);
	}
	if (detail.includes("SSH_LOCAL_PI_RESOURCES_BUSY")) {
		return appError(
			"ssh_local_pi_resources_busy",
			"connection",
			"retry",
			"errors.sshLocalPiResourcesBusy",
			detail,
			true,
		);
	}
	const text = detail.toLowerCase();
	if (
		text.includes("address already in use") ||
		text.includes("eaddrinuse") ||
		/\bos error (?:48|98|10048)\b/.test(text)
	) {
		return appError(
			"port_in_use",
			"runtime",
			"settings",
			"errors.portInUse",
			detail,
			false,
		);
	}
	if (
		text.includes("keychain") ||
		text.includes("keyring") ||
		text.includes("credential store") ||
		text.includes("secret service") ||
		text.includes("errsecauthfailed")
	) {
		return appError(
			"credential_store_unavailable",
			"connection",
			"settings",
			"errors.credentialStoreUnavailable",
			detail,
			false,
		);
	}
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
		/\bos error 2\b/.test(text) ||
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
	const mentionsSizeUnit = /\b\d+\s*(?:kb|mb|gb|bytes?)\b/.test(text);
	const looksLikeFileOrAttachmentLimit =
		(text.includes("file") ||
			text.includes("image") ||
			text.includes("attachment") ||
			text.includes("upload") ||
			text.includes("payload") ||
			text.includes("body") ||
			mentionsSizeUnit) &&
		!text.includes("token") &&
		!text.includes("context") &&
		!text.includes("rate limit") &&
		!text.includes("pi rpc") &&
		!text.includes("rpc line") &&
		!text.includes("stdin");
	if (
		looksLikeFileOrAttachmentLimit &&
		(text.includes("too large") ||
			(text.includes("exceeds") &&
				(text.includes("limit") || text.includes("max") || mentionsSizeUnit)))
	) {
		return appError(
			"file_too_large",
			"session",
			"none",
			"errors.fileTooLarge",
			detail,
			false,
		);
	}
	if (
		text.includes("ssh") ||
		text.includes("wsl") ||
		text.includes("server disconnected") ||
		text.includes("connection refused") ||
		text.includes("connection reset") ||
		text.includes("broken pipe")
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
		return appError(
			"unknown",
			"model",
			"retry",
			looksLikeRawSystemError(detail) ? "errors.requestFailed" : null,
			detail,
			true,
		);
	}
	if (text.includes("extension") || text.includes("mcp")) {
		return appError(
			"unknown",
			"extension",
			"retry",
			looksLikeRawSystemError(detail) ? "errors.requestFailed" : null,
			detail,
			true,
		);
	}
	if (
		text.includes("pi runtime") ||
		text.includes("pi rpc") ||
		text.includes("pi stdout") ||
		text.includes("rpc line") ||
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
	return appError(
		"unknown",
		"unknown",
		"retry",
		looksLikeRawSystemError(detail) ? "errors.requestFailed" : null,
		detail,
		true,
	);
}

export function appErrorMessage(error: AppError): string {
	return error.messageKey
		? t(error.messageKey)
		: (error.detail ?? t("errors.requestFailed"));
}

export function appErrorActionLabel(error: AppError): string | null {
	switch (error.action) {
		case "retry":
			return t("errors.retry");
		case "reconnect":
			return t("errors.reconnect");
		case "settings":
			return t("errors.checkSettings");
		case "none":
			return null;
	}
}

/** 面向用户的错误文案：只说能做什么，原始异常留在 AppError.detail 里。 */
export function userErrorMessage(error: unknown): string {
	return appErrorMessage(toAppError(error));
}
