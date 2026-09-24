import { Check, Folder } from "lucide-react";
import { cn } from "@/lib/utils";
import { DropdownMenuItem } from "@/ui";
import { menuItemIconClassName } from "@/ui/menu-styles";

// 悬浮时才出现的行内操作按钮（Lody loro-app-sidebar 的 hoverActionClassName）。
export const HOVER_ACTION = cn(
	"inline-flex h-5 w-5 items-center justify-center rounded-sm",
	"text-muted-foreground transition-[opacity,background-color,color] duration-100",
	"opacity-0 pointer-events-none",
	"group-hover:opacity-100 group-hover:pointer-events-auto",
	"group-data-[menu-open]:opacity-100 group-data-[menu-open]:pointer-events-auto",
	"focus-visible:opacity-100 focus-visible:pointer-events-auto",
	"hover:text-foreground hover:bg-muted/30 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
	// 不可见时用伪元素把命中区补到 24×24，视觉尺寸保持不变
	"relative after:absolute after:-inset-0.5 after:content-['']",
);

/** 菜单内的迷你开关（比标准 Switch 小一号，适合行内展示）。 */
export function MiniSwitch({ checked }: { checked: boolean }) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors",
				checked ? "bg-primary" : "bg-switch-track",
			)}
		>
			<span
				className={cn(
					"absolute left-0.5 h-3 w-3 rounded-full bg-background shadow-sm transition-transform",
					checked && "translate-x-3",
				)}
			/>
		</span>
	);
}

/** 「视图」分组的单选项：图标 + 文字 + 选中勾。 */
export function ViewMenuItem({
	icon: Icon,
	label,
	selected,
	onSelect,
}: {
	icon: typeof Folder;
	label: string;
	selected: boolean;
	onSelect: () => void;
}) {
	return (
		<DropdownMenuItem onSelect={onSelect}>
			<Icon className={menuItemIconClassName} />
			<span className="min-w-0 flex-1 whitespace-nowrap">{label}</span>
			{selected ? (
				<Check
					className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
					aria-hidden="true"
				/>
			) : null}
		</DropdownMenuItem>
	);
}
