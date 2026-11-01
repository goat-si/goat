// @effect-diagnostics preferSchemaOverJson:off -- Fixtures exercise raw JSON transport frames.
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type { ComputerUseLeaseCallOutcome } from "@goat/contracts";
import { historySink } from "./ComputerUseHistoryProxy.ts";
import { terminalSink } from "./ComputerUseLeaseProxyPersonStop.ts";
import { parse } from "./ComputerUseLeaseProtocol.ts";
import {
  replaceWithTerminal,
  terminalReplyState,
  type ComputerUseTerminalReason,
} from "./ComputerUseTerminal.ts";

export const historyTerminal = (input: {
  readonly possible: boolean;
  readonly reasons: readonly ComputerUseTerminalReason[];
}) =>
  Effect.gen(function* () {
    const reports = yield* Queue.unbounded<ComputerUseLeaseCallOutcome>();
    const scope = yield* Effect.scope;
    let output = "";
    const message = { id: 1, method: "tools/call", params: { name: "click", arguments: {} } };
    const history = historySink(
      { controlId: "control", onCallOutcome: (report) => Queue.offer(reports, report) },
      message,
      new Map(),
      {
        answer: (line) =>
          Effect.sync(() => {
            output = line;
          }),
      },
      scope,
    );
    const sink = terminalSink(
      history,
      message,
      () => replaceWithTerminal("none", ...input.reasons).reason,
      () => false,
    );
    sink.setReservation?.("reservation");
    yield* sink.answer(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          isError: true,
          structuredContent: { code: "unavailable", safety: { possibleCommit: input.possible } },
        },
      }),
      "settled",
    );
    const report = yield* Queue.take(reports);
    if (report.verdict !== (input.possible ? "unknown_outcome" : "refused"))
      throw new Error("History did not record terminal safety");
    return replaceWithTerminal(terminalReplyState(parse(output)?.result));
  });

export const historyCancelled = (input: {
  readonly possible: boolean;
  readonly reasons: readonly ComputerUseTerminalReason[];
}) =>
  Effect.gen(function* () {
    const reports = yield* Queue.unbounded<ComputerUseLeaseCallOutcome>();
    const scope = yield* Effect.scope;
    let recorded = "";
    const message = { id: 1, method: "tools/call", params: { name: "click", arguments: {} } };
    const history = historySink(
      { controlId: "control", onCallOutcome: (report) => Queue.offer(reports, report) },
      message,
      new Map(),
      { answer: () => Effect.void },
      scope,
    );
    const sink = terminalSink(
      {
        ...history,
        recordOutcome: (line, status) => {
          recorded = line;
          return history.recordOutcome?.(line, status) ?? Effect.void;
        },
      },
      message,
      () => replaceWithTerminal("none", ...input.reasons).reason,
      () => false,
    );
    sink.setReservation?.("reservation");
    yield* (
      sink.recordOutcome?.(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            isError: true,
            structuredContent: { code: "unavailable", safety: { possibleCommit: input.possible } },
          },
        }),
      ) ?? Effect.void
    );
    const report = yield* Queue.take(reports);
    if (report.verdict !== (input.possible ? "unknown_outcome" : "refused"))
      throw new Error("History did not record terminal safety");
    return replaceWithTerminal(terminalReplyState(parse(recorded)?.result));
  });
