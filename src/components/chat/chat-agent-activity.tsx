import type { CSSProperties } from "react";

type ActivityLabelStyle = CSSProperties & {
	"--chat-agent-activity-label-duration": string;
};

export function ChatAgentActivityIndicator({ label }: { label: string }) {
	const highlightSteps = Array.from(label).length + 5;
	const labelStyle: ActivityLabelStyle = {
		"--chat-agent-activity-label-duration": `${highlightSteps * 60 + 2_000}ms`,
	};

	return (
		<output className="inline-flex items-center gap-1.5" aria-live="polite">
			<span
				aria-hidden="true"
				className="chat-agent-activity-dot relative inline-grid size-3.5 shrink-0 place-items-center"
			>
				<span className="chat-agent-activity-dot-pulse block size-[34%] rounded-full bg-primary" />
			</span>
			<span
				className="chat-agent-activity-label relative inline-block text-[12.5px] font-medium leading-snug"
				data-highlight-label={label}
				style={labelStyle}
			>
				{label}
			</span>
		</output>
	);
}
