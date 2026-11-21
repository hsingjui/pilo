import type { ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";

export function SortableProjectBlock({
	id,
	disabled,
	row,
	children,
}: {
	id: string;
	disabled: boolean;
	row: ReactNode;
	children?: ReactNode;
}) {
	const {
		isDragging,
		listeners,
		setActivatorNodeRef,
		setNodeRef,
		transform,
		transition,
	} = useSortable({
		id,
		disabled,
		transition: {
			duration: 180,
			easing: "cubic-bezier(0.2, 0, 0, 1)",
		},
	});
	const pointerDown = listeners?.onPointerDown;

	return (
		<div
			ref={setNodeRef}
			style={{
				transform: CSS.Transform.toString(transform),
				transition,
				position: "relative",
				zIndex: isDragging ? 20 : undefined,
			}}
			className="grid w-full min-w-0 gap-px overflow-visible rounded-md"
		>
			<div
				ref={setActivatorNodeRef}
				{...listeners}
				onPointerDown={(event) => {
					const target = event.target as HTMLElement;
					if (
						target.closest(
							"button, input, textarea, select, a, [role='menuitem']",
						)
					) {
						return;
					}
					pointerDown?.(event);
				}}
				className={cn(
					"rounded-md touch-none",
					disabled ? "cursor-default" : "cursor-grab active:cursor-grabbing",
				)}
			>
				<div
					className={cn(
						"rounded-md transition-[transform,opacity,box-shadow] duration-150 ease-out",
						isDragging && "scale-[0.99] opacity-80 shadow-sm",
					)}
				>
					{row}
				</div>
			</div>
			{children}
		</div>
	);
}
