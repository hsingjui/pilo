import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";

import { useIsTouchDevice } from "@/components/chat/chat-composer-run-config";
import type { PiExtensionDialogRequest } from "@/components/chat/use-pi-session-features";
import { cn } from "@/lib/utils";
import {
	menuItemClassName,
	menuSurfaceClassName,
	menuSurfaceStyle,
} from "@/ui/menu-styles";
import { Button, Input, Textarea } from "@/ui";

type ExtensionResponse = {
	value?: string;
	confirmed?: boolean;
	cancelled?: boolean;
};

type PiExtensionUiDialogProps = {
	request: PiExtensionDialogRequest | null;
	onRespond: (response: ExtensionResponse) => void;
};

function keyedOptions(options: readonly string[]) {
	const counts = new Map<string, number>();
	return options.map((option) => {
		const count = counts.get(option) ?? 0;
		counts.set(option, count + 1);
		return { key: `${option}:${count}`, option };
	});
}

function PiExtensionUiDialogContent({
	request,
	onRespond,
}: {
	request: PiExtensionDialogRequest;
	onRespond: (response: ExtensionResponse) => void;
}) {
	const [value, setValue] = useState(request.prefill ?? "");
	const [activeIndex, setActiveIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const editorRef = useRef<HTMLTextAreaElement>(null);
	const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
	const isTouch = useIsTouchDevice();
	const { t } = useTranslation();
	const title = request.title || "Pi Extension";
	const options =
		request.method === "select" ? keyedOptions(request.options) : [];
	const cancel = useCallback(() => onRespond({ cancelled: true }), [onRespond]);

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			cancel();
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [cancel]);

	// 弹窗随 request.id 重挂载；按方法把焦点交给唯一可输入/可选的控件。
	useEffect(() => {
		if (isTouch) return;
		if (request.method === "input") inputRef.current?.focus();
		else if (request.method === "editor") editorRef.current?.focus();
		else if (request.method === "select") optionRefs.current[0]?.focus();
	}, [isTouch, request.method]);

	const moveActive = (delta: number) => {
		if (options.length === 0) return;
		const next = (activeIndex + delta + options.length) % options.length;
		setActiveIndex(next);
		optionRefs.current[next]?.focus();
	};

	const handleSelectKeyDown = (event: React.KeyboardEvent) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			moveActive(event.key === "ArrowDown" ? 1 : -1);
			return;
		}
		const numeric = Number.parseInt(event.key, 10);
		if (numeric >= 1 && numeric <= options.length) {
			event.preventDefault();
			onRespond({ value: options[numeric - 1]?.option });
		}
	};

	return (
		<output
			aria-live="polite"
			className={cn(
				menuSurfaceClassName,
				"mb-2 block overflow-hidden p-0",
				"animate-in fade-in-0 slide-in-from-bottom-1 duration-150",
			)}
			style={menuSurfaceStyle}
		>
			<div className="flex items-start gap-2.5 px-4 pb-2 pt-3">
				<div className="min-w-0 flex-1">
					<div className="truncate text-sm font-medium leading-6 text-foreground">
						{title}
					</div>
					{request.message ? (
						<div className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">
							{request.message}
						</div>
					) : null}
				</div>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className={cn(
						"shrink-0 rounded-lg text-muted-foreground hover:bg-hover hover:text-foreground",
						isTouch ? "-mr-1.5 -mt-1 size-9" : "-mr-1.5 -mt-1 size-7",
					)}
					aria-label={t("common.cancel")}
					onClick={cancel}
				>
					<X className={isTouch ? "size-4" : "size-3.5"} />
				</Button>
			</div>

			{request.method === "select" ? (
				<div className="scrollbar-pro max-h-[min(45vh,20rem)] overflow-y-auto px-1 pb-1">
					{options.map(({ key, option }, index) => (
						<button
							key={key}
							ref={(node) => {
								optionRefs.current[index] = node;
							}}
							type="button"
							onFocus={() => setActiveIndex(index)}
							onMouseEnter={() => setActiveIndex(index)}
							onClick={() => onRespond({ value: option })}
							onKeyDown={handleSelectKeyDown}
							className={cn(
								menuItemClassName,
								"gap-2.5",
								isTouch && "min-h-11",
								index === activeIndex && "bg-hover text-hover-foreground",
							)}
						>
							<span className="flex size-4 shrink-0 items-center justify-center text-2xs tabular-nums text-muted-foreground">
								{index < 9 ? index + 1 : ""}
							</span>
							<span className="min-w-0 flex-1 truncate">{option}</span>
						</button>
					))}
				</div>
			) : null}

			{request.method === "input" ? (
				<div className="px-4 pb-3 pt-1">
					<Input
						ref={inputRef}
						value={value}
						placeholder={request.placeholder ?? undefined}
						onChange={(event) => setValue(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") onRespond({ value });
						}}
					/>
				</div>
			) : null}

			{request.method === "editor" ? (
				<div className="px-4 pb-3 pt-1">
					<Textarea
						ref={editorRef}
						rows={8}
						value={value}
						onChange={(event) => setValue(event.target.value)}
						className="min-h-36 resize-y font-mono text-xs"
					/>
				</div>
			) : null}

			{request.method !== "select" ? (
				<div className="flex justify-end gap-2 px-4 pb-3.5 pt-1">
					{request.method === "confirm" ? (
						<>
							<Button
								variant="outline"
								size="sm"
								className={isTouch ? "h-10 px-4" : undefined}
								onClick={() => onRespond({ confirmed: false })}
							>
								{t("chat.no")}
							</Button>
							<Button
								size="sm"
								className={isTouch ? "h-10 px-4" : undefined}
								onClick={() => onRespond({ confirmed: true })}
							>
								{t("chat.confirm")}
							</Button>
						</>
					) : (
						<>
							<Button
								variant="ghost"
								size="sm"
								className={isTouch ? "h-10 px-4" : undefined}
								onClick={cancel}
							>
								{t("common.cancel")}
							</Button>
							<Button
								size="sm"
								className={isTouch ? "h-10 px-4" : undefined}
								onClick={() => onRespond({ value })}
							>
								{t("common.confirm")}
							</Button>
						</>
					)}
				</div>
			) : null}
		</output>
	);
}

export function PiExtensionUiDialog({
	request,
	onRespond,
}: PiExtensionUiDialogProps) {
	if (!request) return null;
	return (
		<PiExtensionUiDialogContent
			key={request.id}
			request={request}
			onRespond={onRespond}
		/>
	);
}
