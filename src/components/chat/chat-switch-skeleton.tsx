import { useEffect, useState } from "react";

import { ChatHistorySkeleton } from "@/components/chat/chat-history-skeleton";
import { cn } from "@/lib/utils";

// 切换骨架淡出时长：内容在骨架底下就绪后，覆盖层淡出即骨架→内容的交叉淡化，
// 用连续运动掩盖内容替换的闪烁。淡出期间内容已可交互。
const SWITCH_SKELETON_FADE_MS = 200;

// 切换骨架覆盖层：请求出现时立即实心（遮住切换瞬间的空白），
// 请求消失时说明底下内容已就绪并完成滚动复位，淡出交还给真实内容。
// 只做淡出不做淡入——骨架本身就是遮盖，淡入反而会露出背景造成闪烁。
export function SwitchSkeletonOverlay({ covering }: { covering: boolean }) {
	const [mounted, setMounted] = useState(covering);
	const [fading, setFading] = useState(false);
	const [previousCovering, setPreviousCovering] = useState(covering);
	if (covering !== previousCovering) {
		setPreviousCovering(covering);
		// 快速 A→B→A 时从淡出中途拉回实心，打断过渡而不是反向重放。
		setMounted(true);
		setFading(!covering);
	}
	useEffect(() => {
		if (covering || !fading) return;
		const timer = window.setTimeout(
			() => setMounted(false),
			SWITCH_SKELETON_FADE_MS + 50,
		);
		return () => window.clearTimeout(timer);
	}, [covering, fading]);
	if (!mounted) return null;
	return (
		<div
			className={cn(
				"chat-scrollbar absolute inset-0 z-10 overflow-x-hidden overflow-y-auto bg-background transition-opacity ease-out",
				fading ? "pointer-events-none opacity-0 duration-200" : "duration-0",
			)}
		>
			<ChatHistorySkeleton />
		</div>
	);
}
