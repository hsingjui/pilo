import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { listConnectionCatalog } from "@/lib/connections";
import {
	getCachedProjectPiModels,
	hydrateProjectPiModels,
	refreshProjectPiModels,
} from "@/lib/pi-models";
import type { Connection, PiModel } from "@/lib/pi-runtime";
import { connectionLabel, listProjects, type Project } from "@/lib/projects";
import {
	listConnectionNamingModels,
	setConnectionNamingModel,
} from "@/lib/sessions";
import { cn } from "@/lib/utils";
import {
	Button,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/ui";

import {
	SETTINGS_CONTROL_CLASS,
	SettingsRow,
	SettingsSection,
	SETTINGS_ICON_BUTTON_CLASS,
} from "./compact-layout";

type NamingSelection = Pick<PiModel, "provider" | "id">;

function modelKey(model: NamingSelection) {
	return JSON.stringify([model.provider, model.id]);
}

export function SessionNamingSettings() {
	const [connections, setConnections] = useState<Connection[]>([]);
	const [projects, setProjects] = useState<Project[]>([]);
	const [selections, setSelections] = useState<Map<string, NamingSelection>>(
		() => new Map(),
	);
	const [loading, setLoading] = useState(true);
	const [busyConnectionId, setBusyConnectionId] = useState<string | null>(null);
	const [modelRevision, setModelRevision] = useState(0);

	useEffect(() => {
		let active = true;
		void Promise.all([
			listConnectionCatalog(),
			listProjects(),
			listConnectionNamingModels(),
			hydrateProjectPiModels(),
		])
			.then(([catalog, projectList, namingModels]) => {
				if (!active) return;
				setConnections(catalog);
				setProjects(projectList);
				setSelections(
					new Map(
						namingModels.map((item) => [
							item.connectionId,
							{ provider: item.provider, id: item.modelId },
						]),
					),
				);
				setModelRevision((value) => value + 1);
			})
			.catch((error) => {
				if (active) {
					toast.error("读取会话命名设置失败", {
						description: String(error),
					});
				}
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, []);

	void modelRevision;
	const modelsByConnection = new Map<string, PiModel[]>();
	for (const connection of connections) {
		const unique = new Map<string, PiModel>();
		for (const project of projects) {
			if (project.connection.id !== connection.id) continue;
			for (const model of getCachedProjectPiModels(project.id)?.models ?? []) {
				unique.set(modelKey(model), model);
			}
		}
		const selected = selections.get(connection.id);
		if (selected && !unique.has(modelKey(selected))) {
			unique.set(modelKey(selected), {
				...selected,
				name: selected.id,
				reasoning: false,
			});
		}
		modelsByConnection.set(connection.id, [...unique.values()]);
	}

	const saveModel = async (connectionId: string, model: PiModel | null) => {
		setBusyConnectionId(connectionId);
		try {
			await setConnectionNamingModel(connectionId, model);
			setSelections((current) => {
				const next = new Map(current);
				if (model) next.set(connectionId, model);
				else next.delete(connectionId);
				return next;
			});
		} catch (error) {
			toast.error("保存会话命名模型失败", { description: String(error) });
		} finally {
			setBusyConnectionId(null);
		}
	};

	const refreshModels = async (connectionId: string) => {
		const target = projects.reduce<Project | null>((latest, project) => {
			if (project.connection.id !== connectionId) return latest;
			if (!latest || project.lastOpenedAtMs > latest.lastOpenedAtMs)
				return project;
			return latest;
		}, null);
		if (!target) return;
		setBusyConnectionId(connectionId);
		try {
			await refreshProjectPiModels(target.id);
			setModelRevision((value) => value + 1);
			toast.success("模型列表已刷新");
		} catch (error) {
			toast.error("刷新模型失败", { description: String(error) });
		} finally {
			setBusyConnectionId(null);
		}
	};

	return (
		<div className="space-y-3">
			<SettingsSection
				title="会话命名模型"
				description="新会话首条消息发送后，Pilo 使用对应连接指定的模型生成标题。未指定模型时不会自动命名。"
			>
				{loading ? (
					<div className="px-3 py-5 text-xs text-muted-foreground">
						正在读取设置…
					</div>
				) : connections.length === 0 ? (
					<div className="px-3 py-5 text-xs text-muted-foreground">
						暂无可用连接。
					</div>
				) : (
					connections.map((connection) => {
						const models = modelsByConnection.get(connection.id) ?? [];
						const selected = selections.get(connection.id) ?? null;
						const projectCount = projects.filter(
							(project) => project.connection.id === connection.id,
						).length;
						const busy = busyConnectionId === connection.id;
						return (
							<SettingsRow
								key={connection.id}
								label={connectionLabel(connection)}
								helper={
									projectCount > 0
										? `${projectCount} 个项目 · ${models.length} 个可用模型`
										: "该连接暂无项目，因此没有可用的模型缓存。"
								}
							>
								<Select
									value={selected ? modelKey(selected) : "disabled"}
									disabled={busy}
									onValueChange={(value) => {
										if (value === "disabled") {
											void saveModel(connection.id, null);
											return;
										}
										const model = models.find(
											(candidate) => modelKey(candidate) === value,
										);
										if (model) void saveModel(connection.id, model);
									}}
								>
									<SelectTrigger
										className={cn(
											SETTINGS_CONTROL_CLASS,
											"w-[320px] max-w-full",
										)}
									>
										<SelectValue placeholder="选择命名模型" />
									</SelectTrigger>
									<SelectContent className="max-h-80">
										<SelectItem value="disabled">不自动命名</SelectItem>
										{models.map((model) => (
											<SelectItem key={modelKey(model)} value={modelKey(model)}>
												{model.name} · {model.provider}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<Button
									variant="ghost"
									size="icon"
									className={SETTINGS_ICON_BUTTON_CLASS}
									disabled={busy || projectCount === 0}
									onClick={() => void refreshModels(connection.id)}
									title="刷新该连接的模型"
									aria-label="刷新该连接的模型"
								>
									<RefreshCw className={busy ? "animate-spin" : undefined} />
								</Button>
							</SettingsRow>
						);
					})
				)}
			</SettingsSection>
		</div>
	);
}
