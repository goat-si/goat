import type { ChatAttachment } from "@goat/contracts";
import { isNativeMaintenanceCommand } from "./CommandPolicy.ts";

function isGoalCommand(message: {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}): boolean {
  return message.attachments.length === 0 && /^\/goal(?:\s|$)/u.test(message.text.trim());
}

/** A command the provider must run as its own turn: never steered in, never steered into. */
export function isSeparateTurnCommand(message: {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}): boolean {
  return isNativeMaintenanceCommand(message) || isGoalCommand(message);
}
