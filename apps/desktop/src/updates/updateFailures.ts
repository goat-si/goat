import { DesktopUpdateChannelSchema } from "@goat/contracts";
import { errorTag } from "@goat/shared/observability";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";

// Each updater request has its own response deadline (ElectronUpdater.installRequestDeadlines),
// but a check can chain several requests and redirects. This bound frees GOAT's check and
// shows the stall; electron-updater keeps the request in flight and hands it to later
// checks until its own deadline fails it, so one request is ever in flight and its
// eventual result is the current one. It stays well under the poll interval.
export const UPDATE_CHECK_TIMEOUT_MINUTES = 2;
export const UPDATE_CHECK_TIMEOUT = Duration.minutes(UPDATE_CHECK_TIMEOUT_MINUTES);
/** How long quit waits for a running check before installing: the check's deadline plus slack. */
export const UPDATE_CHECK_SETTLE_WAIT = Duration.seconds(UPDATE_CHECK_TIMEOUT_MINUTES * 60 + 15);

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

/**
 * electron-updater reports a failed check with this "error" detail. A check that outlived
 * its deadline can fail later, while a download or install that has nothing to do with it runs.
 */
export function isAbandonedCheckFailure(detail: unknown, activeAction: string | undefined) {
  return (
    typeof detail === "string" &&
    detail.startsWith("Cannot check for updates") &&
    activeAction !== undefined &&
    activeAction !== "check"
  );
}
