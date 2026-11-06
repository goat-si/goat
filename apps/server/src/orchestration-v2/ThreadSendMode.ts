import type { ThreadId } from "@goat/contracts";
import type { ThreadManagementSendMode } from "./ThreadManagementService.ts";

/**
 * The delivery a thread send asks for. Another thread's agent talks like steering whatever mode
 * it named; a thread's own follow-ups and clients outside GOAT threads keep queue and steer.
 */
export function threadSendMode(input: {
  readonly requested: "auto" | "queue" | "steer" | "restart" | undefined;
  readonly senderThreadId: ThreadId | undefined;
  readonly targetThreadId: ThreadId;
}): ThreadManagementSendMode {
  const requested = input.requested ?? "auto";
  if (requested === "restart") return requested;
  if (requested === "auto") return "steer_when_ready";
  return input.senderThreadId !== undefined && input.senderThreadId !== input.targetThreadId
    ? "steer_when_ready"
    : requested;
}
