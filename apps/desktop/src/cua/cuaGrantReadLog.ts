import type { CuaVerificationStepId } from "@goat/contracts";
import * as Effect from "effect/Effect";

/** Who asked: the panel beside System Settings, setup's own reads, or the readiness check. */
export type CuaGrantReadSource = "panel" | "setup" | "verification";

/** The copy that was asked. GOAT itself, where no helper ships, has no bundle path to name. */
export interface CuaGrantReadSubject {
  readonly bundlePath?: string;
  readonly bundleId: string;
}

export interface CuaGrantReadEntry extends CuaGrantReadSubject {
  readonly read: CuaGrantReadSource;
  readonly accessibility?: boolean;
  readonly screenRecording?: boolean;
  /** The code of the failure when the read got no answer. */
  readonly error?: string;
  /** The readiness check's first failed step. */
  readonly failedStep?: CuaVerificationStepId | undefined;
}

/**
 * The failure codes GOAT and its helpers are known to give for a grant read. The helper protocol
 * lets a code be any string, so anything else is logged as one fixed code: the line must stay
 * safe to send.
 */
const KNOWN_ERRORS: ReadonlySet<string> = new Set([
  "no_hello",
  "helper_exited",
  "timeout",
  "protocol_mismatch",
  "bundle_mismatch",
  "malformed_reply",
  "untrusted_parent",
  "unsupported",
  "window_server",
  "unknown_method",
  "bad_request",
  "internal",
]);

/**
 * One log line each time a kind of read finds something else than it did last time, so a report
 * can show which copy was asked and what it said. Setup polls every 1.5 seconds; a poll that
 * finds the same thing writes nothing. Only app paths, ids, booleans and known codes are logged.
 */
export function makeCuaGrantReadLog(channel: string) {
  const last = new Map<CuaGrantReadSource, string>();
  // Untraced because it runs on every poll; a changed outcome opens a span with the line's
  // fields, so desktop.trace.ndjson has them even when another logger takes the message.
  return Effect.fnUntraced(function* (entry: CuaGrantReadEntry) {
    const { failedStep, error, ...found } = entry;
    const line = {
      ...found,
      channel,
      ...(error === undefined
        ? {}
        : { error: KNOWN_ERRORS.has(error) ? error : "unknown_helper_error" }),
      ...(failedStep === undefined ? {} : { failedStep }),
    };
    const key = [
      found.bundlePath,
      found.bundleId,
      found.accessibility,
      found.screenRecording,
      line.error,
      failedStep,
    ].join("\n");
    if (last.get(entry.read) === key) return;
    last.set(entry.read, key);
    yield* Effect.logInfo("Computer use grant read changed", line).pipe(
      Effect.withSpan("desktop.cua.grantRead", { attributes: line }),
    );
  });
}

export type CuaGrantReadLog = ReturnType<typeof makeCuaGrantReadLog>;
