import { isUsageLimitsCommand } from "@goat/shared/usageLimits";

/** A typed GOAT command that send runs locally instead of sending to the provider. */
export function resolveComposerSendIntercept(input: {
  readonly text: string;
  readonly attachmentCount: number;
  readonly usageLimitsOffered: boolean;
  /** The composer belongs to an existing thread, where /fork is always GOAT's. */
  readonly inThread: boolean;
}): "usage-limits" | "fork" | null {
  if (input.usageLimitsOffered && isUsageLimitsCommand(input.text) && input.attachmentCount === 0) {
    return "usage-limits";
  }
  // Attachments stay in the draft for the next message.
  if (input.inThread && input.text.trim().toLowerCase() === "/fork") return "fork";
  return null;
}
