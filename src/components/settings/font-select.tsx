import { useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";

import type { FontOption } from "@/lib/font-settings";
import { cn } from "@/lib/utils";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/ui";

export type FontSelectGroup = {
	label: string;
	options: ReadonlyArray<FontOption>;
};

const TRIGGER_CLASS =
	"flex h-8 items-center justify-between gap-1.5 whitespace-nowrap rounded-md border border-input-border bg-input-field px-3 py-0 text-sm text-input-foreground shadow-xs outline-hidden focus-visible:ring-2 focus-visible:ring-ring";

/**
 * 可搜索的字体选择器：候选按组展示，每组项用各自字体渲染预览，
 * 支持按名称过滤——系统字体候选可达数百个，普通下拉难以浏览。
 *
 * `modal` 是必须的：设置弹窗是模态 Dialog，react-remove-scroll 会在 document
 * 捕获阶段 preventDefault 掉所有 portal 到 Dialog 外的滚轮事件，非 modal 的
 * Popover 列表因此完全无法滚动；modal 让 Popover 自己成为最顶层滚动锁，
 * 其内部滚动放行。
 */
export function FontSelect({
	value,
	groups,
	onChange,
	className,
}: {
	value: string;
	groups: ReadonlyArray<FontSelectGroup>;
	onChange: (value: string) => void;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	const selected = useMemo(
		() =>
			groups
				.flatMap((group) => group.options)
				.find((option) => option.value === value),
		[groups, value],
	);

	return (
		<Popover modal open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					aria-expanded={open}
					className={cn(TRIGGER_CLASS, "w-[200px]", className)}
				>
					<span className="truncate">{selected?.label ?? value}</span>
					<ChevronsUpDown className="size-4 shrink-0 opacity-50" />
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="w-72 min-w-(--radix-popover-trigger-width) p-0"
			>
				<Command>
					<CommandInput
						placeholder="搜索字体…"
						wrapperClassName="h-9"
						className="text-sm"
					/>
					<CommandList>
						<CommandEmpty>未找到匹配字体</CommandEmpty>
						{groups
							.filter((group) => group.options.length > 0)
							.map((group) => (
								<CommandGroup key={group.label} heading={group.label}>
									{group.options.map((option) => (
										<CommandItem
											key={option.value}
											value={option.value}
											keywords={[option.label]}
											onSelect={() => {
												onChange(option.value);
												setOpen(false);
											}}
										>
											<span
												className="truncate"
												style={
													option.family
														? { fontFamily: `"${option.family}"` }
														: undefined
												}
											>
												{option.label}
											</span>
											<Check
												className={cn(
													"ms-auto size-4 shrink-0",
													option.value === value ? "opacity-100" : "opacity-0",
												)}
											/>
										</CommandItem>
									))}
								</CommandGroup>
							))}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
