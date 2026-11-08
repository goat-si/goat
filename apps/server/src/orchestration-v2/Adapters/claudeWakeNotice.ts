import type { RunId } from "@goat/contracts";
import {
  type BackgroundWorkReport,
  backgroundWorkNotification,
} from "@goat/provider-core/server/notification";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

interface ClaudeWakeReportEntry {
  readonly report: BackgroundWorkReport;
  readonly turn: number;
  readonly runId?: RunId;
}

interface ClaudeWakeReportState {
  readonly userTurns: ReadonlyMap<string, number>;
  readonly reports: ReadonlyMap<string, ReadonlyMap<string, ClaudeWakeReportEntry>>;
}

// Wake results lack task ids and can follow queued prompts; retain reports for one user turn.
// Keep report stamps atomic with turn changes.
export const makeClaudeWakeReports = Effect.fn("ClaudeWakeReports.make")(function* (
  wakeRunByTaskId: Ref.Ref<Map<string, RunId>>,
) {
  const wakeReportsByNativeThread = yield* Ref.make<ClaudeWakeReportState>({
    userTurns: new Map(),
    reports: new Map(),
  });
  const recordWakeReport = (nativeThreadId: string, taskId: string, report: BackgroundWorkReport) =>
    // The report keeps the run from here on, so the task's entry goes.
    Ref.modify(wakeRunByTaskId, (runs) => {
      if (!runs.has(taskId)) return [undefined, runs] as const;
      const rest = new Map(runs);
      rest.delete(taskId);
      return [runs.get(taskId), rest] as const;
    }).pipe(
      Effect.flatMap((taken) =>
        Ref.update(wakeReportsByNativeThread, ({ userTurns, reports }) => {
          const runId = taken ?? reports.get(nativeThreadId)?.get(taskId)?.runId;
          return {
            userTurns,
            reports: new Map(reports).set(
              nativeThreadId,
              new Map(reports.get(nativeThreadId)).set(taskId, {
                report,
                turn: userTurns.get(nativeThreadId) ?? 0,
                ...(runId === undefined ? {} : { runId }),
              }),
            ),
          };
        }),
      ),
    );
  const startUserTurnForWakeReports = (nativeThreadId: string) =>
    Ref.update(wakeReportsByNativeThread, ({ userTurns, reports }) => {
      const turn = (userTurns.get(nativeThreadId) ?? 0) + 1;
      const updatedTurns = new Map(userTurns).set(nativeThreadId, turn);
      const threadReports = reports.get(nativeThreadId);
      if (threadReports === undefined) return { userTurns: updatedTurns, reports };
      const kept = new Map([...threadReports].filter(([, entry]) => entry.turn >= turn - 1));
      const updatedReports = new Map(reports);
      if (kept.size === 0) updatedReports.delete(nativeThreadId);
      else updatedReports.set(nativeThreadId, kept);
      return { userTurns: updatedTurns, reports: updatedReports };
    });
  const takeWakeReports = (nativeThreadId: string) =>
    Ref.modify(wakeReportsByNativeThread, (current) => {
      const taken = current.reports.get(nativeThreadId);
      if (taken === undefined) return [taken, current] as const;
      const reports = new Map(current.reports);
      reports.delete(nativeThreadId);
      return [taken, { userTurns: current.userTurns, reports }] as const;
    });
  const clearWakeReports = (nativeThreadId: string) =>
    takeWakeReports(nativeThreadId).pipe(Effect.asVoid);
  return { recordWakeReport, startUserTurnForWakeReports, takeWakeReports, clearWakeReports };
});

export const remember = (
  wakeRunByTaskId: Ref.Ref<Map<string, RunId>>,
  taskId: string,
  runId: RunId | null | undefined,
) => {
  if (runId === undefined || runId === null) return Effect.void;
  return Ref.update(wakeRunByTaskId, (current) => {
    if (current.get(taskId) === runId) return current;
    const updated = new Map(current);
    updated.set(taskId, runId);
    return updated;
  });
};

export const claudeWakeNotification = (
  reports: ReadonlyMap<string, ClaudeWakeReportEntry> | undefined,
) => {
  const entries = [...(reports?.values() ?? [])];
  const notification = backgroundWorkNotification(entries.map((entry) => entry.report));
  const runId = entries[0]?.runId;
  if (
    notification === null ||
    runId === undefined ||
    entries.some((entry) => entry.runId !== runId)
  )
    return notification;
  return { ...notification, aboutRunId: runId };
};
