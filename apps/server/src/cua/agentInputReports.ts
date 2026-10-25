/**
 * The lease proxy's record of its agent's own input calls (#1235): reports that tell the server,
 * which judges every helper's events against all agents' calls, so one agent's input is not
 * taken for a person. The local log only keeps each call's start and end paired.
 *
 * Reports go to the server one at a time, in the order they were made, so an end never overtakes
 * its start. The helper's own input events go through forwardHelperInput. A start is waited for: the call reaches the driver only once the server knows it.
 * An end, as when Stop kills the driver, is queued and never holds anything up.
 *
 * @module agentInputReports
 */
import { COMPUTER_USE_HUMAN_INPUT_BATCH, type ComputerUseHumanInputSource } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { type InputKind, KEEP_MS, makeAgentInputLog } from "./agentInputLog.ts";

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
  };
});

interface HelperInput {
  readonly source: ComputerUseHumanInputSource;
  readonly at: number;
}

/**
 * Sends a helper's keyboard and pointer events to the server until it takes one, and returns
 * then. Every event goes, even one this agent's own call could explain: only the server sees
 * every agent's calls, and with them when a run of cover is too long. Reports are slower than
 * events, so every event that arrived while one report was out goes in the next, in time order
 * (#1488): a pointer streaming dozens of moves a second costs one report per round trip, and a
 * person's event waits behind one report at most. Merging or dropping an event could drop a
 * person's; only events older than the server still judges are dropped, since it would refuse
 * them.
 */
export const forwardHelperInput = Effect.fn("agentInputReports.forwardHelperInput")(
  function* (options: {
    readonly events: Stream.Stream<HelperInput>;
    /** True when the server took one of the events. */
    readonly report: (events: ReadonlyArray<HelperInput>) => Effect.Effect<boolean>;
    /** False once the child the events come from is paused, ended or replaced. */
    readonly current: () => boolean;
  }) {
    const unsent: Array<HelperInput> = [];
    const wake = yield* Queue.sliding<void>(1);
    yield* options.events.pipe(
      Stream.runForEach((input) =>
        Effect.suspend(() => {
          if (!unsent.some((event) => event.source === input.source && event.at === input.at))
            unsent.push({ source: input.source, at: input.at });
          return Queue.offer(wake, undefined);
        }),
      ),
      Effect.forkScoped,
    );
    while (true) {
      yield* Queue.take(wake);
      while (unsent.length > 0) {
        if (!options.current()) return;
        const now = yield* Clock.currentTimeMillis;
        unsent.sort((left, right) => left.at - right.at);
        const batch = unsent
          .splice(0, COMPUTER_USE_HUMAN_INPUT_BATCH)
          .filter((event) => now - event.at < KEEP_MS);
        if (batch.length > 0 && (yield* options.report(batch))) return;
      }
    }
  },
);
