import type { ChannelTask } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ChannelLedger from "../ChannelLedger.ts";
import type { RemoteWorkerState } from "../ChannelRemoteWorkers.ts";
import { onlyTask } from "./ChannelHarness.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/** Observes committed SQLite writes without replacing their behavior or polling the ledger. */
export const taskWriteMilestones = Effect.fn("test.channelWriteMilestones")(function* (
  taskId?: ChannelTask["taskId"],
) {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const completedForwards = new Set<number>();
  const forwardListeners = new Map<number, Deferred.Deferred<void>>();
  const listeners = new Set<{
    readonly check: (task: ChannelTask, state: RemoteWorkerState | undefined) => boolean;
    readonly done: Deferred.Deferred<ChannelTask>;
  }>();
  const notify = Effect.gen(function* () {
    if (listeners.size === 0) return;
    const task = taskId === undefined ? yield* onlyTask : (yield* ledger.getTask(taskId))?.task;
    if (task === undefined) return;
    const json = yield* ledger.getRemoteWorker(task.taskId);
    const state =
      json === undefined ? undefined : (decodeJson(json) as RemoteWorkerState | undefined);
    for (const listener of listeners) {
      if (!listener.check(task, state)) continue;
      listeners.delete(listener);
      yield* Deferred.succeed(listener.done, task);
    }
  }).pipe(Effect.provideService(ChannelLedger.ChannelLedger, ledger));
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      // These two methods stay live; the wrappers only signal after their writes commit.
      const observed: {
        updateRemoteWorker: typeof ledger.updateRemoteWorker;
        applyTaskEvent: typeof ledger.applyTaskEvent;
        completeForward: typeof ledger.completeForward;
      } = ledger;
      const update = observed.updateRemoteWorker;
      const apply = observed.applyTaskEvent;
      const complete = observed.completeForward;
      observed.completeForward = (input) =>
        complete(input).pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
              completedForwards.add(input.sequence);
              const done = forwardListeners.get(input.sequence);
              if (done !== undefined) yield* Deferred.succeed(done, undefined);
            }),
          ),
        );
      observed.updateRemoteWorker = (input) => update(input).pipe(Effect.tap(() => notify));
      observed.applyTaskEvent = (input) => apply(input).pipe(Effect.tap(() => notify));
      return () => {
        observed.updateRemoteWorker = update;
        observed.applyTaskEvent = apply;
        observed.completeForward = complete;
      };
    }),
    (restore) => Effect.sync(restore),
  );
  return {
    waitForForward: Effect.fn("test.waitForForward")(function* (sequence: number) {
      if (completedForwards.has(sequence)) return;
      const done = yield* Deferred.make<void>();
      forwardListeners.set(sequence, done);
      yield* Deferred.await(done);
    }),
    waitFor: Effect.fn("test.waitFor")(function* (
      check: (task: ChannelTask, state: RemoteWorkerState | undefined) => boolean,
    ) {
      const done = yield* Deferred.make<ChannelTask>();
      listeners.add({ check, done });
      yield* notify;
      return yield* Deferred.await(done);
    }),
  };
});
