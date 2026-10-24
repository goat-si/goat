/**
 * ChannelRuntime - runs the channel workers in the one process that owns them.
 *
 * The owner holds the ledger's worker row (refreshed every few seconds) and runs one pass of
 * work whenever a writer signals or a short interval passes: answer new inputs (one at a time
 * per conversation, in arrival order, and up to four conversations at once, each on its own
 * fiber), dispatch received tasks, forward answers, word task updates,
 * bring running tasks in line with their worker threads, and deliver due outbox rows. Run
 * events from worker threads only wake the loop; every pass decides from the ledger and the
 * thread projections, so restarts and missed signals change only timing.
 *
 * @module ChannelRuntime
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the owner token only needs a random UUID.
import * as NodeCrypto from "node:crypto";

import type { ChannelInputId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ChannelChildWork from "./ChannelChildWork.ts";
import * as ChannelDeliveryWorker from "./ChannelDeliveryWorker.ts";
import * as ChannelDispatcher from "./ChannelDispatcher.ts";
import { hasUnsettledChannelDelivery } from "./channelDeliveryGate.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import * as ChannelRemoteWorkers from "./ChannelRemoteWorkers.ts";
import * as ChannelWake from "./ChannelWake.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import * as ImessageChannelRuntime from "./imessage/ImessageChannelRuntime.ts";

const HEARTBEAT_MS = 10_000;
const STALE_MS = 30_000;
const SCAN_MS = 5_000;
const RECEPTION_CONCURRENCY = 4;

export class ChannelRuntime extends Context.Service<
  ChannelRuntime,
  {
    /** Runs passes until a pass starts nothing new and every reception it started finished. */
    readonly drain: Effect.Effect<void, ChannelLedger.ChannelLedgerError>;
    /** One pass, without waiting for the receptions it forks. */
    readonly runPass: Effect.Effect<number, ChannelLedger.ChannelLedgerError>;
    /** Waits for the named inputs' receptions, if they are running. */
    readonly settle: (inputIds: ReadonlyArray<ChannelInputId>) => Effect.Effect<void>;
    /** What a new owner does first: settle deliveries a previous owner left in flight. */
    readonly recover: Effect.Effect<void, ChannelLedger.ChannelLedgerError>;
    readonly ownerToken: string;
  }
>()("goat/channels/ChannelRuntime") {}

const make = Effect.gen(function* () {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const reception = yield* ChannelReceptionService.ChannelReceptionService;
  const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
  const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
  const delivery = yield* ChannelDeliveryWorker.ChannelDeliveryWorker;
  const childWork = yield* ChannelChildWork.ChannelChildWork;
  const sql = yield* SqlClient.SqlClient;
  const remoteWorkers = yield* ChannelRemoteWorkers.ChannelRemoteWorkers;
  const imessage = yield* ImessageChannelRuntime.ImessageChannelRuntime;
  const owner = "channel-owner:" + NodeCrypto.randomUUID();
  const receptionSlots = yield* Semaphore.make(RECEPTION_CONCURRENCY);
  const inFlight = yield* Ref.make(new Map<ChannelInputId, Fiber.Fiber<void, unknown>>());
  const scope = yield* Effect.scope;

  const claim = Effect.gen(function* () {
    const now = yield* DateTime.now;
    return yield* ledger.claimOwnership({
      token: owner,
      now: DateTime.formatIso(now),
      staleBefore: DateTime.formatIso(DateTime.subtractDuration(now, Duration.millis(STALE_MS))),
    });
  });

  const startReception = (inputId: ChannelInputId) =>
    Effect.gen(function* () {
      const running = yield* Ref.get(inFlight);
      if (running.has(inputId)) return false;
      const fiber = yield* receptionSlots
        .withPermits(1)(reception.receive(inputId, owner))
        .pipe(
          Effect.tapCause((cause) =>
            Effect.logWarning("channel reception crashed", { inputId, cause }),
          ),
          Effect.ignore,
          Effect.ensuring(
            Ref.update(inFlight, (current) => {
              const next = new Map(current);
              next.delete(inputId);
              return next;
            }),
          ),
          Effect.forkIn(scope),
        );
      yield* Ref.update(inFlight, (current) => new Map(current).set(inputId, fiber));
      return true;
    });

  const runPass = Effect.gen(function* () {
    // A Messages read failure must not stall other channels, but a lost owner or cursor fence
    // means this process no longer owns the workers, so it stops the pass like any other write.
    let started = yield* imessage.pollDue(owner).pipe(
      Effect.catchIf(
        (error) => error.reason !== "ownership_lost" && error.reason !== "version_conflict",
        (error) =>
          Effect.logWarning("iMessage poll failed", {
            category: error.detail.startsWith("iMessage database ")
              ? error.detail.slice("iMessage database ".length)
              : error.reason,
            detail: error.detail,
          }).pipe(Effect.as(0)),
      ),
    );
    // Only each conversation's oldest input is offered, so a conversation is read in order while
    // others proceed; at most one fiber per conversation waits for a reception slot.
    for (const inputId of yield* ledger.listReceivableInputs(100)) {
      if (yield* startReception(inputId)) started += 1;
    }
    // Oldest request first, so work held back by the per-person cap starts in arrival order.
    const waiting = (yield* ledger.listTasksByStatus(["received", "dispatching"])).toSorted(
      (left, right) => left.task.createdAt.localeCompare(right.task.createdAt),
    );
    for (const stored of waiting) {
      // The acknowledgement goes out before the work starts: while its delivery could still
      // reach the person, the task waits at received until that delivery settles.
      if (
        stored.task.status === "received" &&
        (yield* hasUnsettledChannelDelivery(sql, stored.task.originInputId))
      )
        continue;
      yield* dispatcher.dispatch(stored.task.taskId, owner);
      started += 1;
    }
    for (const pending of yield* ledger.listPendingForwards(50)) {
      yield* dispatcher.forward(pending, owner);
      started += 1;
    }
    for (const pending of yield* ledger.listPendingNarrations(50)) {
      yield* reception.narrate(pending, owner);
      started += 1;
    }
    started += yield* reports.reconcile(owner);
    // Child-work records settle against their destinations in the same pass, so capacity freed
    // by a finished child is visible before the next admission.
    started += yield* childWork.reconcile.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("channel child-work reconcile failed", { cause }).pipe(Effect.as(0)),
      ),
    );
    // Observers of workers on other machines run on their own fibers; this only starts missing ones.
    started += yield* remoteWorkers.ensure(owner);
    started += yield* delivery.deliverDue(owner);
    return started;
  });

  const awaitReceptions = Effect.gen(function* () {
    const running = [...(yield* Ref.get(inFlight)).values()];
    yield* Effect.forEach(running, (fiber) => Fiber.await(fiber), { discard: true });
    return running.length;
  });

  const settle = (inputIds: ReadonlyArray<ChannelInputId>) =>
    Effect.gen(function* () {
      const running = yield* Ref.get(inFlight);
      yield* Effect.forEach(
        inputIds.flatMap((inputId) => {
          const fiber = running.get(inputId);
          return fiber === undefined ? [] : [fiber];
        }),
        (fiber) => Fiber.await(fiber),
        { discard: true },
      );
    });

  const recover = Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* ledger.settleInterruptedDeliveries({ owner, now });
  });

  const drain = Effect.gen(function* () {
    if (!(yield* claim)) return;
    // A forked reception may commit work for the next pass, so stop only when nothing moved.
    for (let pass = 0; pass < 50; pass += 1) {
      const started = yield* runPass;
      const awaited = yield* awaitReceptions;
      if (started === 0 && awaited === 0) return;
    }
  });

  return ChannelRuntime.of({ drain, runPass, settle, recover, ownerToken: owner });
});

/** The runtime service alone, for tests that drive passes themselves. */
export const layer = Layer.effect(ChannelRuntime, make);

/**
 * The runtime plus its background loops: ownership heartbeat, wake-driven passes with a short
 * scan interval, and run events from worker threads as extra wake-ups.
 */
export const layerBackground = Layer.effectDiscard(
  Effect.gen(function* () {
    const runtime = yield* ChannelRuntime;
    const ledger = yield* ChannelLedger.ChannelLedger;
    const wake = yield* ChannelWake.ChannelWake;
    const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
    const eventSink = yield* EventSink.EventSinkV2;
    const owning = yield* Ref.make(false);

    const heartbeat = Effect.gen(function* () {
      const now = yield* DateTime.now;
      const owns = yield* ledger.claimOwnership({
        token: runtime.ownerToken,
        now: DateTime.formatIso(now),
        staleBefore: DateTime.formatIso(DateTime.subtractDuration(now, Duration.millis(STALE_MS))),
      });
      const before = yield* Ref.getAndSet(owning, owns);
      if (owns && !before) {
        // Newly owning: deliveries a previous owner left in flight are settled before new work.
        yield* runtime.recover;
        yield* wake.wake;
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("channel ownership check failed", { cause })),
    );

    const passes = Effect.gen(function* () {
      yield* Effect.raceFirst(wake.next, Effect.sleep(Duration.millis(SCAN_MS)));
      if (!(yield* Ref.get(owning))) return;
      yield* runtime.runPass.pipe(
        Effect.catchCause((cause) => Effect.logWarning("channel worker pass failed", { cause })),
      );
    });

    const runEvents = Stream.unwrap(
      eventSink
        .latestSequence()
        .pipe(
          Effect.map((latest) =>
            eventSink.stream({ afterSequence: latest, eventType: "run.updated" }),
          ),
        ),
    ).pipe(
      Stream.runForEach((stored) =>
        reports.isWorkerThread(stored.event.threadId).pipe(
          Effect.flatMap((isWorker) => (isWorker ? wake.wake : Effect.void)),
          Effect.ignore,
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("channel run event stream stopped", { cause }),
      ),
    );

    yield* heartbeat.pipe(
      Effect.repeat(Schedule.spaced(Duration.millis(HEARTBEAT_MS))),
      Effect.forkScoped,
    );
    yield* passes.pipe(Effect.forever, Effect.forkScoped);
    yield* runEvents.pipe(Effect.forkScoped);
  }),
);
