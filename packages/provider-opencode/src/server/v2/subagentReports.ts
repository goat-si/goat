// @effect-diagnostics nodeBuiltinImport:off -- hash native answer text without retaining it.
import * as NodeCrypto from "node:crypto";
import { isOrchestrationV2WorkActive } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { subagentResultPreview, TRACKING_LOST } from "../subagentResult.ts";
import { stringField, subagentOutput, textOf } from "./adapterUtilities.ts";
import type { OpenCode2StreamEvent } from "./OpenCode2Client.ts";
import type { ActiveTurn, SubagentCall, ThreadState, TurnTerminal } from "./adapterState.ts";

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
  const recoverable = new Set<SubagentCall>();
  const reportWhileRunning = new WeakSet<ActiveTurn>();
  const nativeEnds = new WeakSet<ActiveTurn>();

  const remember = (turn: ActiveTurn, entry: UnreportedCall): UnreportedCall | undefined => {
    if (reportWhileRunning.has(turn)) return entry;
    waiting.set(entry.call, entry);
    if (waiting.size <= MAX_UNREPORTED_CALLS) return;
    const oldest = waiting.values().next();
    if (oldest.done) return;
    waiting.delete(oldest.value.call);
    return oldest.value;
  };

  const loseTracking = (call: SubagentCall) => {
    call.state.calls.delete(call.toolId);
    call.status = "idle";
    call.result = TRACKING_LOST;
    call.prompt = subagentResultPreview(call.prompt);
    if (recoverable.size >= MAX_UNREPORTED_CALLS) {
      const oldest = recoverable.values().next();
      if (!oldest.done) recoverable.delete(oldest.value);
    }
    recoverable.add(call);
  };

  return {
    isRecoverable: (call: SubagentCall) => recoverable.has(call),
    forget(call: SubagentCall) {
      waiting.delete(call);
      recoverable.delete(call);
    },
    bindStart(calls: ReadonlyArray<SubagentCall>, ordinal: number) {
      const unbound = calls.filter((call) => call.run === undefined);
      const sole = unbound.length === 1 ? unbound[0] : undefined;
      if (sole !== undefined && sole.unboundExecutionsLeft === undefined) {
        sole.run = ordinal;
      } else if (unbound.length > 1) {
        for (const call of unbound) call.unboundExecutionsLeft ??= unbound.length;
      }
    },
    recordNativeEnd: (turn: ActiveTurn) => nativeEnds.add(turn),
    finishChild: Effect.fnUntraced(function* (
      turn: ActiveTurn,
      terminal: TurnTerminal,
      { call, turns }: NonNullable<ThreadState["subagent"]>,
      attached: ReadonlyArray<SubagentCall>,
      settle: (
        call: SubagentCall,
        status: SubagentCall["status"],
        result?: string,
      ) => Effect.Effect<void>,
      publish: (call: SubagentCall) => Effect.Effect<void>,
    ) {
      if (nativeEnds.delete(turn)) {
        for (const candidate of attached) {
          if (candidate.unboundExecutionsLeft === undefined || candidate.run !== undefined)
            continue;
          if (--candidate.unboundExecutionsLeft !== 0) continue;
          loseTracking(candidate);
          yield* publish(candidate);
        }
      }
      if (terminal.status !== "failed") {
        for (const candidate of attached) {
          if (candidate.run !== turns || !isOrchestrationV2WorkActive(candidate.status)) continue;
          const evicted = remember(turn, {
            call: candidate,
            answer: turn.answer,
            status: terminal.status,
          });
          if (evicted) yield* settle(evicted.call, evicted.status, evicted.answer?.preview);
        }
      }
      turn.answer = undefined;
      if (!call.background && terminal.status !== "completed" && !recoverable.has(call))
        yield* settle(call, terminal.status);
      if (terminal.status === "failed") {
        for (const candidate of attached) {
          if (candidate.run === turns)
            yield* settle(candidate, terminal.status, terminal.failure.message);
        }
      }
    }),
    recover(state: ThreadState, event: OpenCode2StreamEvent) {
      if (
        recoverable.size === 0 ||
        (event.type !== "session.tool.success" && event.type !== "session.tool.failed")
      )
        return;
      const call = [...recoverable].find(
        (candidate) =>
          candidate.state === state &&
          candidate.toolId === event.data.id &&
          candidate.assistantMessageId === event.data.assistantMessageID,
      );
      if (call === undefined) return;
      if (event.type === "session.tool.failed") {
        const { type, message } = event.data.error;
        return {
          call,
          status: type === "aborted" ? ("interrupted" as const) : ("failed" as const),
          result: message,
        };
      }
      if (event.data.metadata?.["status"] === "running") return;
      const reportedChild = stringField(event.data.metadata, "sessionID");
      if (reportedChild !== undefined && reportedChild !== call.child?.sessionId) return;
      return {
        call,
        status: "completed" as const,
        result: subagentOutput(textOf(event.data.content)),
      };
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
          ? child.turns === 0
            ? open.length === 1 && open[0]?.run === undefined
              ? open
              : []
            : open.filter((call) => call.run === 1)
          : [];
      const state = stringField(payload.metadata, "state");
      const outcome =
        state === "completed" || state === "failed" || state === "cancelled"
          ? stopped
            ? "interrupted"
            : state
          : undefined;
      // A new child ID identifies the first execution only when the call binding is unambiguous.
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
