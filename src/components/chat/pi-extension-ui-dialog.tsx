import { useState } from "react";

import type { PiExtensionDialogRequest } from "@/components/chat/use-pi-session-features";
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
	Textarea,
} from "@/ui";

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
	const title = request.title || "Pi Extension";
	const cancel = () => onRespond({ cancelled: true });

	return (
		<Dialog open onOpenChange={(open) => !open && cancel()}>
			<DialogContent className="w-[min(440px,calc(100vw-2rem))] max-w-none gap-4">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					{request.message ? (
						<DialogDescription>{request.message}</DialogDescription>
					) : null}
				</DialogHeader>

				{request.method === "select" ? (
					<div className="grid gap-1.5">
						{keyedOptions(request.options).map(({ key, option }) => (
							<Button
								key={key}
								variant="outline"
								className="justify-start"
								onClick={() => onRespond({ value: option })}
							>
								{option}
							</Button>
						))}
					</div>
				) : null}

				{request.method === "input" ? (
					<Input
						value={value}
						placeholder={request.placeholder ?? undefined}
						onChange={(event) => setValue(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") onRespond({ value });
						}}
					/>
				) : null}

				{request.method === "editor" ? (
					<Textarea
						rows={10}
						value={value}
						onChange={(event) => setValue(event.target.value)}
						className="min-h-48 resize-y font-mono text-xs"
					/>
				) : null}

				<DialogFooter>
					{request.method === "confirm" ? (
						/* confirm 协议需要区分“显式否”（confirmed: false）与“直接关闭”
						   （cancelled），否不能合并进取消；取消由 Esc / 关闭按钮承担。 */
						<>
							<Button
								variant="outline"
								onClick={() => onRespond({ confirmed: false })}
							>
								否
							</Button>
							<Button onClick={() => onRespond({ confirmed: true })}>是</Button>
						</>
					) : (
						<>
							<Button variant="ghost" onClick={cancel}>
								取消
							</Button>
							{request.method === "input" || request.method === "editor" ? (
								<Button onClick={() => onRespond({ value })}>确定</Button>
							) : null}
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
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
