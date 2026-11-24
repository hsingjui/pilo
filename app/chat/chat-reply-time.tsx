import { platform, signal, Text } from "nsh";

import { Button } from "../ui/button";
import { Popover } from "../ui/popover";
import { textTooltip } from "../ui/tooltip";
import { chatFooterHeight, chatMetadataText, chatPx } from "./layout";

function formatDetail(timestampMs: number | undefined) {
	if (timestampMs === undefined) return "";
	const date = new Date(timestampMs);
	if (!Number.isFinite(date.getTime())) return "";
	const pad = (value: number) => String(value).padStart(2, "0");
	const year = String(date.getFullYear()).padStart(4, "0");
	const day = `${year}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
	return `${day} ${time}`;
}

export function ChatReplyTime(props: { time: string; endedAtMs?: number }) {
	const open = signal(false);
	const detail = () => formatDetail(props.endedAtMs);
	const label = () => (
		<Text
			class="font-sans tabular-nums text-muted-foreground"
			style={chatMetadataText}
		>
			{() => props.time}
		</Text>
	);
	return () =>
		detail() ? (
			<Popover
				open={open()}
				onOpenChange={({ open: next }) => open.set(next)}
				placement="top"
				offset={chatPx(4)}
				margin={8}
				popupClass="p-0"
				popupStyle={{
					paddingHorizontal: chatPx(8),
					paddingVertical: chatPx(4),
				}}
				trigger={
					<Button
						variant="ghost"
						class="shrink-0 p-0"
						style={{
							height: chatFooterHeight(platform.desktop),
							minWidth: platform.desktop ? undefined : 44,
						}}
						accessibilityLabel={detail()}
						tooltip={open() ? undefined : textTooltip(detail)}
					>
						{label()}
					</Button>
				}
			>
				<Text
					class="font-sans tabular-nums text-popover-foreground"
					style={chatMetadataText}
				>
					{detail}
				</Text>
			</Popover>
		) : (
			label()
		);
}
