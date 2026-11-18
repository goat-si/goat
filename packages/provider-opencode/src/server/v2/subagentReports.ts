// @effect-diagnostics nodeBuiltinImport:off -- hash native answer text without retaining it.
import * as NodeCrypto from "node:crypto";
import { subagentResultPreview } from "../subagentResult.ts";
import { stringField, subagentOutput } from "./adapterUtilities.ts";
import type { ActiveTurn, SubagentCall, TurnTerminal } from "./adapterState.ts";

const MAX_UNREPORTED_CALLS = 128;

const fingerprintOf = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

export const subagentAnswer = (messageId: string, text: string) => ({
  messageId,
  fingerprint: fingerprintOf(text),
  preview: subagentResultPreview(text),
});
export type SubagentAnswer = ReturnType<typeof subagentAnswer>;

interface UnreportedCall {
  readonly call: SubagentCall;
  readonly answer: SubagentAnswer | undefined;
  readonly status: Exclude<TurnTerminal["status"], "failed">;
}

export function makeSubagentReports() {
  const waiting = new Map<SubagentCall, UnreportedCall>();
  const reportWhileRunning = new WeakSet<ActiveTurn>();
  return {
    forget: (call: SubagentCall) => waiting.delete(call),
    remember(turn: ActiveTurn, entry: UnreportedCall): UnreportedCall | undefined {
      if (reportWhileRunning.has(turn)) return entry;
      waiting.set(entry.call, entry);
      if (waiting.size <= MAX_UNREPORTED_CALLS) return;
      const oldest = waiting.values().next();
      if (oldest.done) return;
      waiting.delete(oldest.value.call);
      return oldest.value;
    },
    reconcile(
      candidates: Iterable<SubagentCall>,
      childId: string,
      payload: {
        readonly text: string;
        readonly metadata?: Readonly<Record<string, unknown>> | undefined;
      },
      stopped: boolean,
    ) {
      const open = [...candidates].filter((call) => call.child?.sessionId === childId);
      const childState = open[0]?.child;
      const child = childState?.subagent;
      if (child === undefined) return { call: undefined, settled: [] };
      if (childState?.active !== undefined) reportWhileRunning.add(childState.active);
      const output = subagentOutput(payload.text);
      const messageId = stringField(payload.metadata, "assistantMessageID");
      const fingerprint = fingerprintOf(output);
      const ended = open.flatMap((call) => {
        const entry = waiting.get(call);
        return entry === undefined ? [] : [entry];
      });
      const matches = ended.filter(({ answer }) =>
        messageId === undefined
          ? answer?.fingerprint === fingerprint
          : answer?.messageId === messageId,
      );
      const lastMatch = Math.max(0, ...matches.map(({ call }) => call.run ?? 0));
      const firstRun =
        child.fresh && child.turns <= 1
          ? open.filter((call) => call.run === (child.turns === 0 ? undefined : 1))
          : [];
      const state = stringField(payload.metadata, "state");
      const outcome =
        state === "completed" || state === "failed" || state === "cancelled"
          ? stopped
            ? "interrupted"
            : state
          : undefined;
      // A freshly created session's first run is uniquely identified by its child ID.
      const reportCalls =
        outcome !== undefined &&
        messageId === undefined &&
        matches.length === 0 &&
        firstRun.every((call) => waiting.get(call)?.answer === undefined)
          ? firstRun
          : [];
      // Text can prompt reconciliation of confirmed turns. It cannot settle a resumed execution.
      const settled = ended
        .filter(
          ({ call, answer }) =>
            !reportCalls.includes(call) &&
            (answer === undefined || (call.run !== undefined && call.run <= lastMatch)),
        )
        .map(({ call, status, answer }) => ({ call, status, result: answer?.preview }));
      return {
        call:
          messageId === undefined
            ? (matches.find(({ call }) => firstRun.includes(call))?.call ?? reportCalls[0])
            : matches[0]?.call,
        settled:
          outcome === undefined
            ? settled
            : [
                ...settled,
                ...reportCalls.map((call) => ({
                  call,
                  status: waiting.get(call)?.status ?? outcome,
                  result: output,
                })),
              ],
      };
    },
  };
}
