export const historyTypedText = (
  value: string,
  keepTypedText: boolean,
  field: "normal" | "secure" | "unknown",
): { readonly length: number; readonly text?: string } => ({
  length: value.length,
  ...(keepTypedText && field === "normal" ? { text: value } : {}),
});
