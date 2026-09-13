import { cn } from "@/lib/utils";
import { SettingsRow, SettingsSection } from "./compact-layout";

export function SettingsStatus({
	children,
	muted = false,
}: {
	children: string;
	muted?: boolean;
}) {
	return (
		<span
			className={cn(
				"inline-flex h-6 items-center rounded-md border px-2 text-[11px] font-medium",
				muted
					? "border-border/60 bg-muted/35 text-muted-foreground"
					: "border-border/70 bg-background text-foreground/80",
			)}
		>
			{children}
		</span>
	);
}

export function ConnectionsSettings() {
	return (
		<div className="space-y-3">
			<SettingsSection
				title="连接环境"
				description="Connection 只描述 Pi 的运行位置；Project 与 Session 保持独立。"
			>
				<SettingsRow
					label="Local"
					helper="管理本机 Pi 可执行文件、版本检测与本地运行环境。"
				>
					<SettingsStatus>已接入 · 管理页待补</SettingsStatus>
				</SettingsRow>
				<SettingsRow
					label="WSL"
					helper="管理发行版、Pi / Node / Git 环境信息与重连行为。"
				>
					<SettingsStatus>已接入 · 管理页待补</SettingsStatus>
				</SettingsRow>
				<SettingsRow
					label="SSH"
					helper="使用系统 OpenSSH，兼容 ~/.ssh/config、SSH Agent、IdentityFile 与 ProxyJump。"
				>
					<SettingsStatus>已接入 · 管理页待补</SettingsStatus>
				</SettingsRow>
			</SettingsSection>

			<SettingsSection title="默认行为">
				<SettingsRow
					label="按 Project 选择 Connection"
					helper="Pi 始终在代码所在环境运行，不在 Local / WSL / SSH 之间跨环境复用进程。"
				>
					<SettingsStatus>固定策略</SettingsStatus>
				</SettingsRow>
			</SettingsSection>
		</div>
	);
}

export function SessionSettings() {
	return (
		<div className="space-y-3">
			<SettingsSection
				title="会话索引"
				description="Pi JSONL 保持唯一事实来源，Pilo 只保存可重建的索引和桌面状态。"
			>
				<SettingsRow
					label="Session Index"
					helper="使用 SQLite 缓存 session metadata，加快项目打开和历史列表加载。"
				>
					<SettingsStatus>已启用</SettingsStatus>
				</SettingsRow>
				<SettingsRow
					label="自动刷新"
					helper="打开 Project、窗口重新获得焦点或 Pi 运行状态更新时 reconcile Session JSONL。"
				>
					<SettingsStatus>已启用</SettingsStatus>
				</SettingsRow>
				<SettingsRow
					label="Pin / Archive / Search"
					helper="这些状态属于 Pilo 的呈现与索引层，不修改 Pi conversation truth。"
				>
					<SettingsStatus>已接入</SettingsStatus>
				</SettingsRow>
			</SettingsSection>
		</div>
	);
}

export function PiSettings() {
	return (
		<div className="space-y-3">
			<SettingsSection
				title="Pi Runtime"
				description="Pilo 负责进程生命周期与桌面交互，不重新实现 Pi 的 Agent 能力。"
			>
				<SettingsRow
					label="Pi 可执行文件"
					helper="按 Connection 检测 Pi 路径和版本；后续支持自定义路径与诊断。"
				>
					<SettingsStatus>自动检测</SettingsStatus>
				</SettingsRow>
				<SettingsRow
					label="默认模型与思考级别"
					helper="作为新 Session 的默认值；单个 Session 仍可在 Composer 中覆盖。"
				>
					<SettingsStatus muted>规划中</SettingsStatus>
				</SettingsRow>
				<SettingsRow
					label="Extension UI Bridge"
					helper="支持 select、confirm、input、editor、notify、status、widget 与 title。"
				>
					<SettingsStatus muted>规划中</SettingsStatus>
				</SettingsRow>
			</SettingsSection>

			<SettingsSection title="运行时行为">
				<SettingsRow
					label="进程生命周期"
					helper="spawn / stop / restart / abort 由 Pilo Runtime 统一管理，并忽略旧 generation 的 stale events。"
				>
					<SettingsStatus>已接入</SettingsStatus>
				</SettingsRow>
			</SettingsSection>
		</div>
	);
}

export function DiagnosticsSettings() {
	return (
		<div className="space-y-3">
			<SettingsSection
				title="诊断"
				description="集中处理运行环境、Pi RPC 和桌面端问题排查。"
			>
				<SettingsRow
					label="Pi Diagnostics"
					helper="检查 Pi、Node、Git、cwd、Connection 和 RPC 基础可用性。"
				>
					<SettingsStatus muted>规划中</SettingsStatus>
				</SettingsRow>
				<SettingsRow
					label="Runtime Logs"
					helper="查看 Pi stderr、Pilo Runtime 日志与最近一次进程退出信息。"
				>
					<SettingsStatus muted>规划中</SettingsStatus>
				</SettingsRow>
				<SettingsRow
					label="Crash Recovery"
					helper="保存必要桌面状态，并在异常退出后安全恢复 Project 与 Session。"
				>
					<SettingsStatus muted>规划中</SettingsStatus>
				</SettingsRow>
			</SettingsSection>
		</div>
	);
}
