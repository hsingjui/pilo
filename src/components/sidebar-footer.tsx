import { Clock, HelpCircle, Monitor, Moon, Settings, Sun } from "lucide-react";
import { nextCycledTheme, useTheme, type Theme } from "@/lib/theme-provider";
import {
	Button,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	Checkbox,
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
	Input,
	Label,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Switch,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/ui";

const THEME_LABELS: Record<Theme, string> = {
	light: "亮色",
	dark: "暗色",
	system: "跟随系统",
};

const THEME_ICONS: Record<Theme, typeof Sun> = {
	light: Sun,
	dark: Moon,
	system: Monitor,
};

function ThemeCycleButton() {
	const { theme, setTheme } = useTheme();
	const Icon = THEME_ICONS[theme];
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					aria-label="切换主题"
					onClick={() => setTheme(nextCycledTheme(theme))}
				>
					<Icon />
				</Button>
			</TooltipTrigger>
			<TooltipContent>主题：{THEME_LABELS[theme]}</TooltipContent>
		</Tooltip>
	);
}

function SettingsDialog() {
	const { theme, setTheme } = useTheme();
	return (
		<Dialog>
			<Tooltip>
				<TooltipTrigger asChild>
					<span>
						<DialogTrigger asChild>
							<Button variant="ghost" size="icon" aria-label="设置">
								<Settings />
							</Button>
						</DialogTrigger>
					</span>
				</TooltipTrigger>
				<TooltipContent>设置</TooltipContent>
			</Tooltip>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>设置</DialogTitle>
				</DialogHeader>
				<Card>
					<CardHeader>
						<CardTitle className="text-base">外观</CardTitle>
					</CardHeader>
					<CardContent className="flex items-center justify-between gap-4">
						<Label htmlFor="theme-select">主题</Label>
						<Select value={theme} onValueChange={(v) => setTheme(v as Theme)}>
							<SelectTrigger id="theme-select" className="w-40">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{(Object.keys(THEME_LABELS) as Theme[]).map((t) => (
									<SelectItem key={t} value={t}>
										{THEME_LABELS[t]}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle className="text-base">通用</CardTitle>
					</CardHeader>
					<CardContent className="grid gap-4">
						<div className="flex items-center justify-between gap-4">
							<Label htmlFor="display-name">昵称</Label>
							<Input
								id="display-name"
								placeholder="Pilo 用户"
								className="w-40"
							/>
						</div>
						<div className="flex items-center justify-between gap-4">
							<Label htmlFor="notifications">启用通知</Label>
							<Switch id="notifications" />
						</div>
						<div className="flex items-center justify-between gap-4">
							<Label htmlFor="auto-update">自动检查更新</Label>
							<Checkbox id="auto-update" defaultChecked />
						</div>
					</CardContent>
				</Card>
			</DialogContent>
		</Dialog>
	);
}

export function SidebarFooter() {
	return (
		<>
			<SettingsDialog />
			<Tooltip>
				<TooltipTrigger asChild>
					<Button variant="ghost" size="icon" aria-label="帮助">
						<HelpCircle />
					</Button>
				</TooltipTrigger>
				<TooltipContent>帮助</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button variant="ghost" size="icon" aria-label="历史">
						<Clock />
					</Button>
				</TooltipTrigger>
				<TooltipContent>历史</TooltipContent>
			</Tooltip>
			<span className="ms-auto">
				<ThemeCycleButton />
			</span>
		</>
	);
}
