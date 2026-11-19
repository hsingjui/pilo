import { View } from "nsh";

import { t } from "../app/i18n";
import { Skeleton } from "../ui/skeleton";
import { ConversationColumn } from "./conversation-column";

type Turn = {
	user: string;
	/** The collapsed work line a reply usually opens with. */
	activity?: string;
	lines: readonly string[];
};

// Oldest first, in fixed uneven widths, so the newest turn sits at the bottom
// where the chat's last messages land.
const turns: readonly Turn[] = [
	{ user: "w-[36%]", lines: ["w-[86%]", "w-[62%]"] },
	{
		user: "w-[30%]",
		activity: "w-[26%]",
		lines: ["w-[90%]", "w-[74%]", "w-[52%]"],
	},
	{ user: "w-[44%]", lines: ["w-[80%]", "w-[92%]", "w-[66%]", "w-[38%]"] },
	{
		user: "w-[34%]",
		activity: "w-[30%]",
		lines: ["w-[82%]", "w-[68%]", "w-[48%]"],
	},
	{ user: "w-[41%]", lines: ["w-[72%]", "w-[88%]", "w-[58%]"] },
	{
		user: "w-[29%]",
		activity: "w-[24%]",
		lines: ["w-[90%]", "w-[64%]", "w-[40%]"],
	},
];

/** A chat's history is being read: turns in outline, resting at the bottom. */
export function ChatHistorySkeleton() {
	return (
		<View
			testID="chat-history-loading"
			class="min-h-0 flex-1 justify-end overflow-hidden pt-6 pb-10"
			accessibilityLabel={t("chat.historyLoading")}
		>
			<ConversationColumn class="shrink-0">
				<Each of={turns} key={(turn) => turn.user}>
					{(turn) => (
						<View>
							<View class="items-end py-3">
								<Skeleton
									strong
									class={`h-11 rounded-(--pilo-bubble-radius) ${turn().user}`}
								/>
							</View>
							<View class="py-3">
								{turn().activity ? (
									<View class="mb-1.5 h-7 flex-row items-center gap-2">
										<Skeleton class="size-3.5 shrink-0 rounded-(--pilo-radius-sm)" />
										<Skeleton class={`h-2.5 ${turn().activity}`} />
									</View>
								) : null}
								<View class="gap-2.5 py-1">
									<Each of={turn().lines}>
										{(width) => <Skeleton class={`h-3 ${width()}`} />}
									</Each>
								</View>
								<View class="mt-0.5 h-7" />
							</View>
						</View>
					)}
				</Each>
			</ConversationColumn>
		</View>
	);
}
