export const describe = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : String(error);

export const lastText = (texts: ReadonlyArray<string | null | undefined>) =>
  texts.findLast((text): text is string => typeof text === "string" && text.trim().length > 0) ??
  null;
