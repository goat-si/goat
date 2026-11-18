export type OrchestrationV2GoalCommand =
  | { readonly type: "show" }
  | { readonly type: "clear" }
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  | { readonly type: "set"; readonly objective: string };

/** Reads a `/goal` control message. Messages with attachments are ordinary prompts. */
export function parseGoalCommand(message: {
  readonly text: string;
  readonly attachments?: ReadonlyArray<unknown> | undefined;
}): OrchestrationV2GoalCommand | null {
  if ((message.attachments?.length ?? 0) > 0) return null;
  const match = /^\/goal(?:\s+([\s\S]*))?$/u.exec(message.text.trim());
  if (match === null) return null;
  const argument = (match[1] ?? "").trim();
  switch (argument.toLowerCase()) {
    case "":
    case "edit":
      return { type: "show" };
    case "clear":
      return { type: "clear" };
    case "pause":
      return { type: "pause" };
    case "resume":
      return { type: "resume" };
    default:
      return { type: "set", objective: argument };
  }
}
