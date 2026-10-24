/**
 * The lease proxy's record of its agent's own input calls (#1235): a local log its helper's
 * events are judged against, and reports that tell the server, so another agent's helper seeing
 * that input is not taken for a person.
 *
 * Reports go to the server one at a time, in the order they were made, so an end never overtakes
 * its start. A start is waited for: the call reaches the driver only once the server knows it.
 * An end, as when Stop kills the driver, is queued and never holds anything up.
 *
 * @module agentInputReports
 */
import type { ComputerUseHumanInputSource } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";

import { type InputKind, makeAgentInputLog } from "./agentInputLog.ts";

export interface AgentInputReport {
  readonly call: string;
  readonly state: "start" | "end";
  readonly at: number;
  readonly kinds?: ReadonlyArray<InputKind>;
}

export const makeAgentInputReports = Effect.fn("agentInputReports.make")(function* (options: {
  readonly send: ((report: AgentInputReport) => Effect.Effect<unknown>) | undefined;
  /** Completes when the control ends; a start still waiting on its report stops waiting. */
  readonly ended: Effect.Effect<unknown>;
}) {
  const log = makeAgentInputLog();
  const reports = yield* Queue.unbounded<{
    readonly report: AgentInputReport;
    readonly sent?: Deferred.Deferred<void>;
  }>();
  const send = options.send;
  if (send !== undefined)
    yield* Queue.take(reports).pipe(
      Effect.flatMap(({ report, sent }) =>
        send(report).pipe(
          Effect.ignoreCause,
          Effect.andThen(sent === undefined ? Effect.void : Deferred.succeed(sent, undefined)),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
  const end = (call: string, at: number) =>
    send === undefined
      ? Effect.void
      : Queue.offer(reports, { report: { call, state: "end", at } }).pipe(Effect.asVoid);
  return {
    /** Records a call that can post input and waits until the server has its start. */
    started: Effect.fn("agentInputReports.started")(function* (
      call: string,
      kinds: ReadonlyArray<InputKind>,
    ) {
      const at = yield* Clock.currentTimeMillis;
      log.prune(at);
      log.started(call, at, kinds);
      if (send === undefined) return;
      const sent = yield* Deferred.make<void>();
      yield* Queue.offer(reports, { report: { call, state: "start", at, kinds }, sent });
      // A failed report answers too: then another agent's helper may pause everyone for this
      // call's events, which errs toward the person.
      yield* Effect.raceFirst(Deferred.await(sent), options.ended.pipe(Effect.asVoid));
    }),
    /** A call answered, was cancelled or was refused after its start. */
    ended: Effect.fn("agentInputReports.ended")(function* (call: string) {
      const at = yield* Clock.currentTimeMillis;
      if (log.ended(call, at)) yield* end(call, at);
    }),
    /** Every open call ends, as when the driver child is stopped. */
    endAll: Effect.fn("agentInputReports.endAll")(function* () {
      const at = yield* Clock.currentTimeMillis;
      for (const call of log.endAll(at)) yield* end(call, at);
    }),
    isAgents: (at: number, source: ComputerUseHumanInputSource) => log.isAgents(at, source),
  };
});
