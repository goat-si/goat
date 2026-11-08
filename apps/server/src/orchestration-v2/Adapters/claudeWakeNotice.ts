import type { BackgroundWorkReport } from "@goat/provider-core/server/notification";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

interface ClaudeWakeReportEntry {
  readonly report: BackgroundWorkReport;
  readonly turn: number;
}

interface ClaudeWakeReportState {
  readonly userTurns: ReadonlyMap<string, number>;
  readonly reports: ReadonlyMap<string, ReadonlyMap<string, ClaudeWakeReportEntry>>;
}

// Wake results lack task ids and can follow queued prompts; retain reports for one user turn.
// Keep report stamps atomic with turn changes.
export const makeClaudeWakeReports = Effect.fn("ClaudeWakeReports.make")(function* () {
  const wakeReportsByNativeThread = yield* Ref.make<ClaudeWakeReportState>({
    userTurns: new Map(),
    reports: new Map(),
  });
  const recordWakeReport = (nativeThreadId: string, taskId: string, report: BackgroundWorkReport) =>
    Ref.update(wakeReportsByNativeThread, ({ userTurns, reports }) => ({
      userTurns,
      reports: new Map(reports).set(
        nativeThreadId,
        new Map(reports.get(nativeThreadId)).set(taskId, {
          report,
          turn: userTurns.get(nativeThreadId) ?? 0,
        }),
      ),
    }));
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
