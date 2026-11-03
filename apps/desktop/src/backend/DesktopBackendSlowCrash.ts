import * as Effect from "effect/Effect";
import type { RecoveryRecord } from "./DesktopBackendRecoveryPolicy.ts";
import type * as DesktopObservability from "../app/DesktopObservability.ts";

export interface SlowCrashInfo {
  readonly label: string;
  readonly logPath: string;
  readonly history: ReadonlyArray<{ readonly at: number; readonly outcome: string }>;
}

export interface RecoveryActions {
  readonly label: string;
  readonly reason: string;
  readonly retry: Effect.Effect<void>;
  readonly stop: Effect.Effect<void>;
  readonly logPath: string;
  readonly history?: SlowCrashInfo["history"];
}

export const publishSlowCrash = Effect.fn("desktop.backendInstance.publishSlowCrash")(function* (
  info: SlowCrashInfo,
  recordStop: DesktopObservability.DesktopBackendOutputLogShape["recordStop"],
  notify:
    | ((
        info: SlowCrashInfo,
        onFailure: (reason: string) => Effect.Effect<void>,
      ) => Effect.Effect<void>)
    | undefined,
) {
  const intervals = info.history
    .slice(1)
    .map((entry, index) => Math.round((entry.at - (info.history[index]?.at ?? entry.at)) / 60_000));
  yield* recordStop({
    message: "backend slow crash pattern",
    level: "WARN",
    details: `intervalsMin=[${intervals.join(",")}] outcomes=[${info.history.map((entry) => entry.outcome).join(",")}] logPath=${info.logPath}`,
  });
  yield* (
    notify?.(info, (reason) =>
      recordStop({
        message: "backend slow crash notice not shown",
        level: "WARN",
        details: reason,
      }),
    ) ?? Effect.void
  );
});

export const slowCrashInfo = (
  record: RecoveryRecord,
  label: string,
  logPath: string,
): SlowCrashInfo | undefined =>
  record.notifiedKey !== undefined && (record.history?.length ?? 0) >= 4
    ? { label, logPath, history: record.history ?? [] }
    : undefined;

export const notifySlowCrash = Effect.fn("desktop.backendInstance.notifySlowCrash")(function* (
  record: RecoveryRecord,
  label: Effect.Effect<string>,
  logPath: Effect.Effect<string>,
  recordStop: DesktopObservability.DesktopBackendOutputLogShape["recordStop"],
  notify:
    | ((
        info: SlowCrashInfo,
        onFailure: (reason: string) => Effect.Effect<void>,
      ) => Effect.Effect<void>)
    | undefined,
) {
  const info = slowCrashInfo(record, yield* label, yield* logPath);
  if (info) yield* publishSlowCrash(info, recordStop, notify);
});

export const showBackendRecovery = Effect.fn("desktop.backendInstance.showRecovery")(function* (
  record: RecoveryRecord,
  label: Effect.Effect<string>,
  logPath: Effect.Effect<string>,
  retry: Effect.Effect<void>,
  stop: Effect.Effect<void>,
  show: ((actions: RecoveryActions) => Effect.Effect<void>) | undefined,
) {
  const name = yield* label;
  const path = yield* logPath;
  const info = slowCrashInfo(record, name, path);
  if (record.pause === null && info === undefined) return;
  yield* (
    show?.({
      label: name,
      reason: record.pause ?? "slow-crash",
      ...(info === undefined ? {} : { history: info.history }),
      retry,
      stop,
      logPath: path,
    }) ?? Effect.void
  );
});
