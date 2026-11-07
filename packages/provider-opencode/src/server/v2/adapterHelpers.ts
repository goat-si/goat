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
