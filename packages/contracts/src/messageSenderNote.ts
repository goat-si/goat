import type { OrchestrationV2ConversationMessage } from "./orchestrationV2.ts";

type Sender = Pick<OrchestrationV2ConversationMessage, "text"> &
  Partial<Pick<OrchestrationV2ConversationMessage, "createdBy" | "creationSource">> &
  Partial<
    Pick<OrchestrationV2ConversationMessage, "scheduledTaskId" | "senderThreadId" | "context">
  >;

const LEADING_COMMAND = /^\s*(?:\/|\p{Sc}[a-zA-Z0-9:_-]*[a-zA-Z])/u;

export function withMessageSenderNote(message: Sender, text: string): string {
  const agent = message.createdBy === "agent";
  const remote = message.context?.remoteSender;
  const note =
    agent && remote !== undefined
      ? `[GOAT: the agent in GOAT thread ${JSON.stringify(remote.threadId)} on linked environment ${JSON.stringify(remote.environmentId)} sent this message, not the user.]`
      : agent && message.senderThreadId !== undefined
        ? `[GOAT: the agent in GOAT thread ${JSON.stringify(message.senderThreadId)} sent this message, not the user.]`
        : message.scheduledTaskId !== undefined
          ? `[GOAT: scheduled task ${JSON.stringify(message.scheduledTaskId)} sent this prompt, not the user typing in this chat.]`
          : agent && message.creationSource === "mcp"
            ? "[GOAT: this message came through GOAT's tools, not from the user typing in this chat.]"
            : undefined;
  if (note === undefined || LEADING_COMMAND.test(message.text)) return text;
  return text === "" ? note : `${note}\n\n${text}`;
}
