export const reportOutcome = (state: string | undefined) =>
  state === "completed"
    ? ("completed" as const)
    : state === "error"
      ? ("failed" as const)
      : state === "cancelled"
        ? ("cancelled" as const)
        : ("unknown" as const);

export const commandOf = (text: string) => {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match?.[1] === undefined ? undefined : { name: match[1], text: match[2] ?? "" };
};

// Steer before decline; otherwise the model sees only Unable to execute command and retries.
export const declinedNote = (action: string, resources: ReadonlyArray<string>) =>
  `The user declined the ${action} request${resources.length === 0 ? "" : ` (${resources.join(", ")})`}. Do not retry it; continue without it or ask the user how to proceed.`;

export const sessionGrantLabel = (action: string, save: ReadonlyArray<string>) =>
  save.every((pattern) => pattern === "*")
    ? `Allow every ${action} request this session`
    : `Allow ${save.join(", ")} this session`;
