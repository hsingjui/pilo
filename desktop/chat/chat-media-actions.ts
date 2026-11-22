import { context } from "nsh";

/** An image to display in the full-screen preview lightbox. */
export interface ChatImagePreview {
	/** External URL or base64 data URL. */
	url: string;
	/** Display title and suggested save filename. */
	name: string;
	/** File size in bytes, when known. */
	size?: number;
}

/** Shared preview/open callbacks provided by the app shell to chat rows. */
export interface ChatMediaActionsValue {
	openImage?: (image: ChatImagePreview) => void;
	openFile?: (path: string) => void;
	canOpenFile?: (path: string) => boolean;
}

export const ChatMediaActions = context<ChatMediaActionsValue>({});
