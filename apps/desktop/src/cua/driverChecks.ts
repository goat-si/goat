import type { ToolResult } from "@trycua/cua-driver";
import * as Option from "effect/Option";

// What the readiness check reads from the driver's answers; pure, so the driver module stays
// about lifecycle.

export type ToolCall = Option.Option<{ readonly result: ToolResult; readonly structured: unknown }>;

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
export const readString = (value: unknown, key: string) => {
  const found = field(value, key);
  return typeof found === "string" ? found : undefined;
};
export const readNumber = (value: unknown, key: string) => {
  const found = field(value, key);
  return typeof found === "number" ? found : undefined;
};
export const readArray = (value: unknown, key: string): readonly unknown[] => {
  const found = field(value, key);
  return Array.isArray(found) ? found : [];
};

/** Drops the driver's diagnostic tail; the first clause names the cause. */
export function describeDegraded(reason: string): string {
  if (reason.startsWith("screen_locked"))
    return "The screen is locked. Unlock this Mac, then try again.";
  const cause = reason.split(/[.:]/u, 1)[0] ?? reason;
  return `The driver could not see GOAT's window (${cause.replaceAll("_", " ")}).`;
}

export function failedCall(call: ToolCall): string | undefined {
  if (Option.isNone(call)) return "The driver did not answer. Try again.";
  if (call.value.result.isError)
    return call.value.result.text.trim() || "The driver reported an error.";
  return undefined;
}

/** Each check returns why it failed, or undefined when it passed. */
export function permissionsFailure(call: ToolCall): string | undefined {
  const error = failedCall(call);
  if (error !== undefined || Option.isNone(call)) return error;
  const { structured } = call.value;
  if (readString(field(structured, "source"), "attribution") !== "host")
    return "The driver is not running under GOAT's permissions. Restart GOAT.";
  const missing = [
    ...(field(structured, "accessibility") === true ? [] : ["Accessibility"]),
    ...(field(structured, "screen_recording") === true ? [] : ["Screen Recording"]),
  ];
  return missing.length === 0
    ? undefined
    : `The driver does not see ${missing.join(" or ")} yet. Quit and reopen GOAT.`;
}

export function identityFailure(
  call: ToolCall,
  bundleId: string,
  processId: number,
): string | undefined {
  const error = failedCall(call);
  if (error !== undefined || Option.isNone(call)) return error;
  const check = readArray(call.value.structured, "checks").find(
    (entry) => readString(entry, "name") === "bundle_identity",
  );
  const data = field(check, "data");
  const ok =
    readString(check, "status") === "pass" &&
    readString(data, "identity_source") === "parent_application" &&
    readString(data, "bundle_identifier") === bundleId &&
    readNumber(data, "parent_process_id") === processId;
  return ok
    ? undefined
    : (readString(check, "message") ?? "The driver could not confirm it runs inside GOAT.");
}
