import type { ChatAttachment, ChatFileAttachment, ChatImageAttachment } from "@goat/contracts";
import { imageMimeType } from "@goat/shared/image";

// Virtualization remounts old rows; only newly created content should replay an entrance.
const FRESH_ENTRY_WINDOW_MS = 3_000;
export function isFreshTimestamp(input: string): boolean {
  const timestamp = Date.parse(input);
  return Number.isFinite(timestamp) && Date.now() - timestamp < FRESH_ENTRY_WINDOW_MS;
}

export function isImageAttachment(attachment: ChatAttachment): attachment is ChatImageAttachment {
  return attachment.type === "image" || imageMimeType(attachment) !== null;
}

export function isFileAttachment(attachment: ChatAttachment): attachment is ChatFileAttachment {
  return attachment.type === "file";
}

/** Leads with why GOAT compacted, when it did so without being asked. */
export function compactionLabel(label: string, title: string | undefined) {
  return title !== undefined && label.startsWith("Context compacted")
    ? title + label.slice("Context compacted".length)
    : label;
}
