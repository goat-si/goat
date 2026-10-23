import { DesktopUpdateChannelSchema } from "@goat/contracts";
import { errorTag } from "@goat/shared/observability";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";

// electron-updater has no deadline of its own under Electron (see ElectronUpdater.checkForUpdates).
// A check is two small feed requests, so this bound stays well under the poll interval.
export const UPDATE_CHECK_TIMEOUT_MINUTES = 2;
export const UPDATE_CHECK_TIMEOUT = Duration.minutes(UPDATE_CHECK_TIMEOUT_MINUTES);

export class DesktopUpdateCheckTimeoutError extends Schema.TaggedError<DesktopUpdateCheckTimeoutError>()(
  "DesktopUpdateCheckTimeoutError",
  {
    channel: DesktopUpdateChannelSchema,
  },
) {
  override get message(): string {
    return `Desktop update check on channel ${this.channel} did not finish within ${UPDATE_CHECK_TIMEOUT_MINUTES} minutes.`;
  }
}

function redactMessage(message: string): string {
  return (message.split(/[\r\n]/, 1)[0] ?? "")
    .replace(/\b(?:https?|file):\/\/[^\s"'<>]+/gi, "[redacted URL]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, "[redacted credential]")
    .replace(
      /\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=].*$/gi,
      "[redacted header]",
    )
    .replace(
      /\b[\w-]*(?:token|password|secret|credential|api[_-]?key)[\w-]*\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "[redacted credential]",
    )
    .slice(0, 512);
}

function summarizeCause(cause: unknown, depth: number): string {
  if (depth >= 3) return "[truncated cause]";
  if (Cause.isCause(cause)) {
    return cause.reasons
      .slice(0, 3)
      .map((reason) =>
        reason._tag === "Fail"
          ? summarizeCause(reason.error, depth + 1)
          : reason._tag === "Die"
            ? summarizeCause(reason.defect, depth + 1)
            : "Interrupted",
      )
      .join("; ");
  }
  if (typeof cause === "string") return redactMessage(cause);
  if (typeof cause !== "object" || cause === null) return errorTag(cause);

  const error = cause as {
    readonly message?: unknown;
    readonly code?: unknown;
    readonly cause?: unknown;
  };
  const code =
    typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code)
      ? ` [${error.code}]`
      : "";
  const message = typeof error.message === "string" ? `: ${redactMessage(error.message)}` : "";
  const nested =
    error.cause === undefined ? "" : `; caused by ${summarizeCause(error.cause, depth + 1)}`;
  return `${errorTag(cause)}${code}${message}${nested}`;
}

export function describeUpdateErrorCause(cause: unknown): string {
  try {
    return summarizeCause(cause, 0).slice(0, 1024);
  } catch {
    return "UnknownError";
  }
}

export function checkFailureMessage(reason: string): string {
  return `Could not check for updates: ${reason}`;
}
