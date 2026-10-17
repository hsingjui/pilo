import { useEffect, useSyncExternalStore } from "react";

/**
 * 打开项目内文件（桌面端落到右侧 ProjectViewer）。
 *
 * 工具行要把文件路径变成可点入口，但消息渲染层级有五六层，逐层传参会污染
 * 一路上的组件签名。这里沿用聊天区既有的模块级 external store 做法
 * （见 chat-image-viewer 的图片查看器）：App 注册动作，工具行订阅读取。
 * WebUI 没有查看器，也就没有注册者，读到 null 时工具行退回不可点的纯文本。
 */
type ChatFileOpenHandler = (path: string) => void;

let opener: ChatFileOpenHandler | null = null;
const listeners = new Set<() => void>();

function emit() {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function useChatFileOpener(onOpenFile: ChatFileOpenHandler | undefined) {
	useEffect(() => {
		if (!onOpenFile) return;
		opener = onOpenFile;
		emit();
		return () => {
			if (opener === onOpenFile) {
				opener = null;
				emit();
			}
		};
	}, [onOpenFile]);
}

/** 当前可用的打开动作；没有注册者时为 null。 */
export function useChatFileOpen() {
	return useSyncExternalStore(
		subscribe,
		() => opener,
		() => opener,
	);
}
