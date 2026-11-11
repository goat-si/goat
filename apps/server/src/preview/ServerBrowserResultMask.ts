import type { PreviewAutomationRequest } from "@goat/contracts";

/** Fields GOAT itself fills in its answers; masking one would only corrupt the answer's shape. */
const SERVER_KEYS = new Set([
  "_tag",
  "reason",
  "phase",
  "status",
  "level",
  "requestId",
  "tabId",
  "id",
  "ref",
]);

export const walk = (value: unknown, mask: (text: string) => string, keys: boolean): unknown => {
  if (typeof value === "string") return mask(value);
  if (Array.isArray(value)) return value.map((each) => walk(each, mask, keys));
  if (value === null || typeof value !== "object") return value;
  // Page-made JSON (`keys`) is the page's throughout; only server-built shapes keep their fields.
  return Object.fromEntries(
    Object.entries(value).map(([key, each]) => [
      keys ? mask(key) : key,
      !keys && SERVER_KEYS.has(key) && typeof each === "string" ? each : walk(each, mask, keys),
    ]),
  );
};

/** Page-derived JSON can carry a value in its keys; server-built shapes keep theirs. */
export const maskResult = (
  operation: PreviewAutomationRequest["operation"],
  result: unknown,
  mask: (text: string, cut?: boolean) => string,
): unknown => {
  if (operation === "evaluate") return walk(result, mask, true);
  if (result === null || typeof result !== "object" || Array.isArray(result))
    return walk(result, mask, false);
  const record = result as Record<string, unknown>;
  const masked = walk(record, mask, false) as Record<string, unknown>;
  if (operation === "scrollCollect" && Array.isArray(record.items))
    masked.items = walk(record.items, mask, true);
  if (operation === "fetch" && record.truncated === true && typeof record.text === "string")
    masked.text = mask(record.text, true);
  // Chromium encodes these pixels; text replacement would only corrupt them.
  if (operation === "snapshot") {
    for (const key of ["screenshot", "fullScreenshot"] as const) {
      const image = record[key] as { readonly data?: unknown } | undefined;
      if (typeof image?.data === "string")
        masked[key] = { ...(masked[key] as object), data: image.data };
    }
  }
  return masked;
};
