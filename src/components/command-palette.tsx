import { useMemo, useState, type ReactNode } from "react";
import { MessagesSquare } from "lucide-react";

import { CommandDialog, CommandInput, CommandItem, CommandList } from "@/ui";
import type { SidebarSession } from "./sidebar/types";

type CommandPaletteProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	sessions: SidebarSession[];
	onSelectSession?: (sessionId: string) => void;
};

function Kbd({ children }: { children: ReactNode }) {
	return (
		<kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-sm bg-muted px-1 font-sans text-[11px] font-medium text-muted-foreground select-none">
			{children}
		</kbd>
	);
}

export function CommandPalette({
	open,
	onOpenChange,
	sessions,
	onSelectSession,
}: CommandPaletteProps) {
	const [query, setQuery] = useState("");

	const results = useMemo(() => {
		const normalized = query.trim().toLocaleLowerCase();
		if (!normalized) return sessions;
		return sessions.filter((session) =>
			[session.title, session.preview ?? "", session.sessionPath]
				.join("\n")
				.toLocaleLowerCase()
				.includes(normalized),
		);
	}, [query, sessions]);

	const choose = (session: SidebarSession) => {
		onSelectSession?.(session.id);
		onOpenChange(false);
	};

	return (
		<CommandDialog
			open={open}
			onOpenChange={(next) => {
				// 关闭时清空关键词，避免下次打开残留上次的搜索内容。
				if (!next) setQuery("");
				onOpenChange(next);
			}}
			shouldFilter={false}
		>
			<CommandInput
				value={query}
				onValueChange={setQuery}
				placeholder="搜索会话…"
			/>
			{results.length === 0 ? (
				<div className="flex flex-1 items-center justify-center px-4 text-sm text-muted-foreground">
					没有找到会话
				</div>
			) : (
				<CommandList
					className="px-0 py-1.5"
					containerClassName="max-h-none min-h-0 flex-1"
					viewportClassName="max-h-none h-full"
				>
					{results.map((session) => (
						<CommandItem
							key={session.id}
							value={session.id}
							onSelect={() => choose(session)}
							className="mx-1.5 my-px"
						>
							<MessagesSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
							<span className="min-w-0 flex-1 truncate">{session.title}</span>
						</CommandItem>
					))}
				</CommandList>
			)}
			<footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-[11px] text-muted-foreground">
				<div className="flex items-center gap-3">
					<span className="flex items-center gap-1">
						<Kbd>↑</Kbd>
						<Kbd>↓</Kbd>
						切换
					</span>
					<span className="flex items-center gap-1">
						<Kbd>↵</Kbd>
						选择
					</span>
				</div>
				<span className="flex items-center gap-1">
					<Kbd>esc</Kbd>
					关闭
				</span>
			</footer>
		</CommandDialog>
	);
}
