// @effect-diagnostics nodeBuiltinImport:off -- hash native answer text without retaining it.
import * as NodeCrypto from "node:crypto";
import { subagentResultPreview } from "../subagentResult.ts";
import type { SubagentCall, TurnTerminal } from "./adapterState.ts";

const MAX_UNREPORTED_CALLS = 128;
const MAX_RETIRED_REPORTS = 128;

const fingerprintOf = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

export const subagentAnswer = (text: string) => ({
  fingerprint: fingerprintOf(text),
  preview: subagentResultPreview(text),
});
export type SubagentAnswer = ReturnType<typeof subagentAnswer>;

interface UnreportedCall {
  readonly call: SubagentCall;
  readonly answer: SubagentAnswer | undefined;
  readonly status: Exclude<TurnTerminal["status"], "failed">;
}

interface RetiredReport {
  readonly childId: string;
  readonly run: number;
  readonly fingerprint: string;
}

export function makeSubagentReports() {
  const waiting = new Map<SubagentCall, UnreportedCall>();
  const retired: RetiredReport[] = [];
  return {
    forget: (call: SubagentCall) => waiting.delete(call),
    remember(entry: UnreportedCall): UnreportedCall | undefined {
      waiting.set(entry.call, entry);
      if (waiting.size <= MAX_UNREPORTED_CALLS) return;
      const oldest = waiting.values().next();
      if (oldest.done) return;
      const evicted = oldest.value;
      waiting.delete(evicted.call);
      const childId = evicted.call.child?.sessionId;
      const run = evicted.call.run;
      const fingerprint = evicted.answer?.fingerprint;
      if (
        childId !== undefined &&
        run !== undefined &&
        fingerprint !== undefined &&
        !retired.some((report) => report.childId === childId && report.run === run)
      ) {
        if (retired.length >= MAX_RETIRED_REPORTS) retired.shift();
        retired.push({ childId, run, fingerprint });
      }
      return evicted;
    },
    match(candidates: Iterable<SubagentCall>, childId: string, output: string) {
      const open = [...candidates].filter((call) => call.child?.sessionId === childId);
      const started = open
        .flatMap((call) => (call.run === undefined ? [] : [{ call, run: call.run }]))
        .sort((a, b) => a.run - b.run);
      const fingerprint = fingerprintOf(output);
      const late = retired.findIndex(
        (report) =>
          report.childId === childId &&
          report.fingerprint === fingerprint &&
          !started.some((candidate) => candidate.run === report.run),
      );
      if (late >= 0) {
        retired.splice(late, 1);
        return { call: undefined, calls: [], skipped: [] };
      }
      // Reports arrive in order. Matching a later known answer proves earlier reports were skipped.
      const next = started.find(({ call }) => {
        const answer = waiting.get(call)?.answer;
        return answer === undefined || answer.fingerprint === fingerprint;
      });
      const matchedRun =
        next !== undefined && waiting.get(next.call)?.answer?.fingerprint === fingerprint
          ? next.run
          : undefined;
      const call = matchedRun === undefined ? open[0] : next?.call;
      const calls =
        call?.run === undefined ? open.slice(0, 1) : open.filter((each) => each.run === call.run);
      const skipped =
        matchedRun === undefined
          ? []
          : started.flatMap((earlier) => {
              const entry = earlier.run < matchedRun ? waiting.get(earlier.call) : undefined;
              return entry === undefined ? [] : [entry];
            });
      if (matchedRun !== undefined) {
        for (let index = retired.length - 1; index >= 0; index--) {
          const report = retired[index];
          if (report?.childId === childId && report.run <= matchedRun) retired.splice(index, 1);
        }
      }
      return { call, calls, skipped };
    },
  };
}
