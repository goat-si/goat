import { cuaAppKey } from "@goat/shared/cuaDriverManifest";
import type { ComputerUseApp, OrchestrationV2ConversationMessage } from "@goat/contracts";

const mentions = (text: string, name: string) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}_])(?<![\\p{L}\\p{M}\\p{N}][.-])${escaped}(?![\\p{L}\\p{M}\\p{N}_]|[.-][\\p{L}\\p{M}\\p{N}_])`,
    "iu",
  ).test(text);
};

export const namedAppMessages = (
  apps: ReadonlyArray<string>,
  catalog: ReadonlyArray<ComputerUseApp>,
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
) =>
  apps.flatMap((app) => {
    const name = catalog.find((entry) => cuaAppKey(entry.id) === cuaAppKey(app))?.name;
    return messages.flatMap((message) =>
      message.role === "user" &&
      message.createdBy === "user" &&
      (message.creationSource === "web" || message.creationSource === "mobile") &&
      message.scheduledTaskId === undefined &&
      message.senderThreadId === undefined &&
      message.channel === undefined &&
      message.workflowScript !== true &&
      (mentions(message.text, app) || (name !== undefined && mentions(message.text, name)))
        ? [{ app, messageId: message.id }]
        : [],
    );
  });
