import {
	Scroll,
	signal,
	Text,
	token,
	untracked,
	View,
	type KeyEvent,
	type ViewRef,
} from "nsh";

import type { ConversationOutlineEntry } from "@/lib/chat/conversation-outline";
import { t } from "../app/i18n";
import { focusRingStyle } from "../ui/focus-ring-style";
import { Tooltip } from "../ui/tooltip";

/** Altura del hueco de cada marca, como en la WebUI. */
const TICK_PITCH = 8;
/** Anchura en reposo de la marca según el peso de la ronda. */
const TICK_WIDTHS = [10, 13, 16, 20] as const;
/** Anchura de la marca activa. */
const ACTIVE_TICK_WIDTH = 24;
/** Anchura del raíl. */
const RAIL_WIDTH = 46;
/** Margen interior a la izquierda de las marcas. */
const TRACK_INSET = 8;

export interface ConversationOutlineRailProps {
	/** Las rondas del chat, una por mensaje del usuario. */
	entries: () => readonly ConversationOutlineEntry[];
	/** La entrada que se está leyendo. */
	activeIndex: () => number;
	/** Salta a la ronda `index` de la lista. */
	onJump: (index: number) => void;
}

/**
 * Las rondas de la conversación como marcas apiladas en el borde izquierdo:
 * cada una salta a su mensaje del usuario (aunque aún no esté cargado),
 * la activa sigue al scroll y el ratón y el teclado la recorren. No se
 * muestra con menos de dos rondas.
 */
export function ConversationOutlineRail(props: ConversationOutlineRailProps) {
	const focused = signal(-1);
	const railHeight = signal(0);
	const ticks: (ViewRef | undefined)[] = [];

	const onKeyDown = (e: KeyEvent) => {
		const count = untracked(props.entries).length;
		let next = -1;
		if (e.key === "ArrowDown") next = Math.min(focused() + 1, count - 1);
		if (e.key === "ArrowUp") next = Math.max(focused() - 1, 0);
		if (e.key === "Home") next = 0;
		if (e.key === "End") next = count - 1;
		if (next >= 0 && next !== focused()) {
			ticks[next]?.focus();
			return;
		}
		if (e.key === "Enter" || e.key === " ") {
			const index = focused();
			if (index >= 0) props.onJump(index);
		}
	};

	return (
		<View
			testID="chat-outline-rail"
			accessibilityLabel={t("chat.messageNavigation")}
			role="navigation"
			class="pointer-events-none absolute inset-y-0 left-0 items-start justify-center"
			style={{ width: RAIL_WIDTH, zIndex: 20 }}
			onLayout={({ bounds }) => railHeight.set(bounds.size.height)}
			onKeyDown={onKeyDown}
		>
			<Scroll
				class="pointer-events-auto py-2"
				style={{ maxHeight: Math.max(railHeight() / 2, TICK_PITCH) }}
			>
				<View class="flex-col" style={{ paddingLeft: TRACK_INSET }}>
					<Each of={props.entries()} key="index">
						{(entry, index) => (
							<View
								testID={`chat-outline-tick-${index()}`}
								focusable
								accessibilityLabel={entry().title}
								ref={(node: ViewRef) => (ticks[index()] = node)}
								focusVisibleStyle={focusRingStyle(token("ring"))}
								class="pointer-events-auto flex-row items-center"
								style={{ height: TICK_PITCH }}
								onFocus={() => focused.set(index())}
								onBlur={() => focused.set(-1)}
								onPress={() => props.onJump(index())}
								tooltip={
									<Tooltip>
										<View class="w-72 gap-1.5">
											<Text class="font-sans text-sm font-medium leading-snug">
												{entry().title}
											</Text>
											<Text class="font-sans text-xs leading-relaxed text-muted-foreground">
												{() => entry().preview || t("chat.noPiReply")}
											</Text>
										</View>
									</Tooltip>
								}
							>
								{() => {
									const active = index() === props.activeIndex();
									return (
										<View
											class={
												active
													? "rounded-full bg-foreground/80"
													: "rounded-full bg-muted-foreground/45 hover:bg-muted-foreground/80 focus:bg-foreground/80"
											}
											style={{
												height: 2,
												width: active
													? Math.max(
															ACTIVE_TICK_WIDTH,
															TICK_WIDTHS[entry().weight] + 4,
														)
													: TICK_WIDTHS[entry().weight],
											}}
										/>
									);
								}}
							</View>
						)}
					</Each>
				</View>
			</Scroll>
		</View>
	);
}
