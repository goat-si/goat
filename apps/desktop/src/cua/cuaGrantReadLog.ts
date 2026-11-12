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
 * One log line each time a kind of read finds something else than it did last time, so a report
 * can show which copy was asked and what it said. Setup polls every 1.5 seconds; a poll that
 * finds the same thing writes nothing. Only app paths, ids and booleans are logged.
 */
export function makeCuaGrantReadLog(channel: string) {
  const last = new Map<CuaGrantReadSource, string>();
  // Untraced because it runs on every poll; a changed outcome opens the span that carries the
  // line into desktop.trace.ndjson.
  return Effect.fnUntraced(function* (entry: CuaGrantReadEntry) {
    const { failedStep, ...found } = entry;
    const line = { ...found, channel, ...(failedStep === undefined ? {} : { failedStep }) };
    const key = [
      found.bundlePath,
      found.bundleId,
      found.accessibility,
      found.screenRecording,
      found.error,
      failedStep,
    ].join("\n");
    if (last.get(entry.read) === key) return;
    last.set(entry.read, key);
    yield* Effect.logInfo("Computer use grant read changed", line).pipe(
      Effect.withSpan("desktop.cua.grantRead"),
    );
  });
}

export type CuaGrantReadLog = ReturnType<typeof makeCuaGrantReadLog>;
