import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { Skeleton } from "@/ui";

const LINE_WIDTHS = [68, 82, 47, 91, 59, 75, 38, 86, 54, 71, 94, 63];
const FILE_WIDTHS = [66, 43, 79, 57, 71, 49, 85, 60];

export function GitDiffSkeleton({
	diffStyle = "unified",
}: {
	diffStyle?: "unified" | "split";
}) {
	const { t } = useTranslation();
	return (
		<output
			aria-busy="true"
			className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
		>
			<span className="sr-only">{t("file.readingDiff")}</span>
			<div
				aria-hidden="true"
				className={cn(
					"grid w-full min-w-0 content-start divide-x divide-border/60",
					diffStyle === "split" ? "grid-cols-2" : "grid-cols-1",
				)}
			>
				{(diffStyle === "split" ? ["before", "after"] : ["unified"]).map(
					(side) => (
						<div key={side} className="min-w-0 py-2">
							{LINE_WIDTHS.map((width) => (
								<div key={width} className="flex h-6 items-center gap-4 px-4">
									<Skeleton className="h-2.5 w-4 shrink-0 rounded-sm bg-muted motion-reduce:animate-none" />
									<div className="min-w-0 flex-1">
										<Skeleton
											className="h-3 rounded-sm bg-muted motion-reduce:animate-none"
											style={{ width: `${width}%` }}
										/>
									</div>
								</div>
							))}
						</div>
					),
				)}
			</div>
		</output>
	);
}

export function GitWorkspaceSkeleton({
	header = true,
	diffStyle = "unified",
	listWidth,
}: {
	header?: boolean;
	diffStyle?: "unified" | "split";
	listWidth?: number;
}) {
	const { t } = useTranslation();
	return (
		<div
			aria-busy="true"
			className={cn(
				"@container/git flex min-h-0 min-w-0 flex-1 flex-col",
				header && "pb-[env(safe-area-inset-bottom)]",
			)}
		>
			<output className="sr-only">{t("file.readingGit")}</output>
			{header ? (
				<div
					aria-hidden="true"
					className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4"
				>
					<Skeleton className="h-4 w-12 bg-muted motion-reduce:animate-none" />
					<Skeleton className="h-5 w-6 bg-muted motion-reduce:animate-none" />
					<Skeleton className="ml-auto h-7 w-20 bg-muted motion-reduce:animate-none" />
					<Skeleton className="size-8 bg-muted motion-reduce:animate-none" />
				</div>
			) : null}
			<div
				aria-hidden="true"
				className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
			>
				<div
					style={{
						width: listWidth === undefined ? undefined : `${listWidth}%`,
					}}
					className="flex min-h-0 min-w-0 flex-1 flex-col bg-muted/15 @min-[40rem]/git:w-64 @min-[40rem]/git:min-w-48 @min-[40rem]/git:max-w-1/2 @min-[40rem]/git:flex-none @min-[40rem]/git:border-r @min-[40rem]/git:border-border/60"
				>
					<div className="flex min-h-10 shrink-0 items-center gap-2 px-3 py-1">
						<Skeleton className="h-8 flex-1 bg-muted motion-reduce:animate-none" />
						<Skeleton className="h-8 flex-1 bg-muted motion-reduce:animate-none" />
					</div>
					<div className="min-h-0 overflow-hidden px-2 pb-2">
						{FILE_WIDTHS.map((width) => (
							<div
								key={width}
								className="flex min-h-8 items-center gap-2.5 px-3 py-1.5 [@media(pointer:coarse)]:min-h-11"
							>
								<Skeleton className="size-4 shrink-0 bg-muted motion-reduce:animate-none" />
								<div className="min-w-0 flex-1">
									<Skeleton
										className="h-3 bg-muted motion-reduce:animate-none"
										style={{ width: `${width}%` }}
									/>
								</div>
								<Skeleton className="size-5 shrink-0 bg-muted motion-reduce:animate-none" />
							</div>
						))}
					</div>
				</div>
				<div className="hidden min-h-0 min-w-0 flex-1 flex-col @min-[40rem]/git:flex">
					<div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
						<Skeleton className="size-5 bg-muted motion-reduce:animate-none" />
						<Skeleton className="h-4 w-32 bg-muted motion-reduce:animate-none" />
						<div className="flex min-w-0 flex-1">
							<Skeleton className="h-2.5 w-24 bg-muted motion-reduce:animate-none" />
						</div>
						<Skeleton className="h-8 w-16 bg-muted motion-reduce:animate-none" />
						<Skeleton className="size-8 bg-muted motion-reduce:animate-none" />
					</div>
					<GitDiffSkeleton diffStyle={diffStyle} />
				</div>
			</div>
		</div>
	);
}
