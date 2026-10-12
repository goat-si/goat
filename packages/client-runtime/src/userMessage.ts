import {
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  ScheduledTaskId,
} from "@t3tools/contracts";
import {
  splitStandingInstructions,
  type StandingInstructionsBlock,
} from "@t3tools/shared/standingInstructions";

const LEGACY_AUTOMATION_PREFIX = /^\[Triggered by schedule task: [^\r\n]+\]\r?\n\r?\n/;
const LEGACY_AUTOMATION_MESSAGE_ID = /^scheduled-task-message:(.+):\d+:(?:scheduled|manual)$/;

interface PresentedUserMessage {
  readonly id?: string;
  readonly role: string;
  readonly text: string;
  readonly createdBy?: OrchestrationV2Actor;
  readonly creationSource?: OrchestrationV2CreationSource;
  readonly scheduledTaskId?: ScheduledTaskId;
}

/**
 * Text and sender label for a user-role message. Older scheduled messages
 * stored their attribution in the prompt itself. A thread an agent launched
 * carries the standing instructions GOAT put in front of its first message;
 * they come back separately so clients can show them collapsed.
 */
export function resolveUserMessagePresentation(message: PresentedUserMessage): {
  readonly text: string;
  /** Who sent a user-role message the user did not type. */
  readonly attribution: "automation" | "agent" | "t3code" | null;
  readonly scheduledTaskId: ScheduledTaskId | undefined;
  readonly standingInstructions: StandingInstructionsBlock | null;
} {
  const split =
    message.role === "user" && message.createdBy === "agent"
      ? splitStandingInstructions(message.text)
      : { block: null, text: message.text };
  return {
    ...resolveSender({ ...message, text: split.text }),
    standingInstructions: split.block,
  };
}

function resolveSender(message: PresentedUserMessage): {
  readonly text: string;
  readonly attribution: "automation" | "agent" | "t3code" | null;
  readonly scheduledTaskId: ScheduledTaskId | undefined;
} {
  if (message.role !== "user") {
    return { text: message.text, attribution: null, scheduledTaskId: undefined };
  }
  if (message.scheduledTaskId !== undefined) {
    return {
      text: message.text,
      attribution: "automation",
      scheduledTaskId: message.scheduledTaskId,
    };
  }
  const legacyPrefix = LEGACY_AUTOMATION_PREFIX.exec(message.text);
  const legacyTaskId = legacyPrefix
    ? LEGACY_AUTOMATION_MESSAGE_ID.exec(message.id ?? "")?.[1]
    : undefined;
  if (legacyPrefix !== null && (legacyTaskId !== undefined || message.createdBy === "agent")) {
    return {
      text: message.text.slice(legacyPrefix[0].length),
      attribution: "automation",
      scheduledTaskId: legacyTaskId === undefined ? undefined : ScheduledTaskId.make(legacyTaskId),
    };
  }
  return {
    text: message.text,
    // Restart continuations were sent as the agent before they became notices.
    attribution:
      message.createdBy !== "agent"
        ? null
        : message.creationSource === "server"
          ? "t3code"
          : "agent",
    scheduledTaskId: undefined,
  };
}
