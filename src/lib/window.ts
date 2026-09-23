import { isTauri } from "@tauri-apps/api/core";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export type NewWindowSessionTarget = {
	sessionId: string;
	projectId: string;
	sessionPath: string;
	title: string;
};

// Windows：与主窗口一致，移除原生装饰、改用前端自绘标题栏（见 src-tauri/src/lib.rs）。
const IS_WINDOWS = isTauri() && navigator.userAgent.includes("Windows");

/** 新窗口按此参数在启动时定位会话（见 App.tsx 的 boot 读取）。 */
export function sessionWindowLabel(sessionId: string): string {
	return `session-${sessionId}`.replace(/[^a-zA-Z0-9\-/:_]/g, "-");
}

/**
 * 当前窗口是否由 openSessionInNewWindow 创建。
 * 以窗口 label 判定（不依赖 URL 是否保留下 query），供布局分支使用。
 */
export function isSessionWindow(): boolean {
	if (!isTauri()) return false;
	return getCurrentWindow().label.startsWith("session-");
}

/** 读取当前窗口 URL 上的会话定位参数（非新窗口场景返回 null）。 */
export function readSessionWindowTarget(): NewWindowSessionTarget | null {
	if (typeof window === "undefined") return null;
	const params = new URLSearchParams(window.location.search);
	const sessionId = params.get("session");
	const projectId = params.get("project");
	if (!sessionId || !projectId) return null;
	return {
		sessionId,
		projectId,
		sessionPath: params.get("path") ?? "",
		title: params.get("title") ?? "",
	};
}

/**
 * 在独立窗口中打开同一个会话。已存在同会话窗口时只聚焦，不重复创建。
 * 返回是否已由 Tauri 处理（非桌面环境返回 false，调用方可忽略）。
 */
export function openSessionInNewWindow(
	target: NewWindowSessionTarget,
): boolean {
	if (!isTauri()) return false;
	const label = sessionWindowLabel(target.sessionId);
	void WebviewWindow.getByLabel(label).then((existing) => {
		if (existing) {
			void existing.setFocus();
			return;
		}
		const params = new URLSearchParams({
			session: target.sessionId,
			project: target.projectId,
			path: target.sessionPath,
			title: target.title,
		});
		new WebviewWindow(label, {
			url: `index.html?${params.toString()}`,
			title: target.title,
			// 会话窗口面向窄屏：默认窄而长，并居中打开。
			width: 480,
			height: 900,
			minWidth: 360,
			minHeight: 420,
			center: true,
			// 与主窗口（tauri.conf.json）保持一致：
			// macOS 保留原生红绿灯并用 Overlay 让内容延伸至顶栏；
			// Windows 移除原生装饰，交给前端自绘标题栏。
			...(IS_WINDOWS
				? { decorations: false, shadow: true }
				: {
						hiddenTitle: true,
						titleBarStyle: "overlay" as const,
						trafficLightPosition: new LogicalPosition(20, 25),
					}),
		}).once("tauri://error", (event) => {
			console.error("Failed to open session window", event);
		});
		return;
	});
	return true;
}
