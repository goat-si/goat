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
 * A separate deadline loop commits the fixed reply for any input still unanswered 55 seconds
 * after acceptance and delivers receipts, so a full set of reception slots or a stuck pass
 * never leaves a person without a first reply.
 *
 * @module ChannelRuntime
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the owner token only needs a random UUID.
import * as NodeCrypto from "node:crypto";

import { ChannelReceptionId, type ChannelInputId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as AutomationHold from "../automationHold.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ChannelChildWork from "./ChannelChildWork.ts";
import * as ChannelDeliveryWorker from "./ChannelDeliveryWorker.ts";
import * as ChannelDispatcher from "./ChannelDispatcher.ts";
import { CHANNEL_COPY } from "./channelCopy.ts";
import { hasUnsettledChannelDelivery } from "./channelDeliveryGate.ts";
import { deliveryIdFor } from "./channelIds.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import * as ChannelSessionFirst from "./ChannelSessionFirst.ts";
import { isSessionClaim } from "./channelSessionReceipt.ts";
import { readReceiptSettlement } from "./channelReceiptSettlement.ts";
import * as ChannelRemoteWorkers from "./ChannelRemoteWorkers.ts";
import * as ChannelWake from "./ChannelWake.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import * as ImessageChannelRuntime from "./imessage/ImessageChannelRuntime.ts";

const HEARTBEAT_MS = 10_000;
const STALE_MS = 30_000;
const SCAN_MS = 5_000;
const RECEPTION_CONCURRENCY = 4;
const REPLY_DEADLINE_MS = 55_000;
const DEADLINE_SCAN_MS = 1_000;
const isChannelLedgerError = Schema.is(ChannelLedger.ChannelLedgerError);

export class ChannelRuntime extends Context.Service<
  ChannelRuntime,
  {
    /** Runs passes until a pass starts nothing new and every reception it started finished. */
    readonly drain: Effect.Effect<void, ChannelLedger.ChannelLedgerError>;
    /** One pass, without waiting for the receptions it forks. */
    readonly runPass: Effect.Effect<number, ChannelLedger.ChannelLedgerError>;
    /** Commits timeout replies independently of reception slots and ordinary passes. */
    readonly expireOverdue: Effect.Effect<number, ChannelLedger.ChannelLedgerError>;
    /** Delivers due receipts independently of ordinary passes, even when nothing expired. */
    readonly deliverReceipts: Effect.Effect<number, ChannelLedger.ChannelLedgerError>;
    /** Waits for the named inputs' receptions, if they are running. */
    readonly settle: (inputIds: ReadonlyArray<ChannelInputId>) => Effect.Effect<void>;
    /** What a new owner does first: settle deliveries a previous owner left in flight. */
    readonly recover: Effect.Effect<void, ChannelLedger.ChannelLedgerError>;
    readonly ownerToken: string;
  }
>()("goat/channels/ChannelRuntime") {}

const make = Effect.gen(function* () {
  const hold = yield* AutomationHold.AutomationHold;
  const ledger = yield* ChannelLedger.ChannelLedger;
  const reception = yield* ChannelReceptionService.ChannelReceptionService;
  const sessionFirst = yield* ChannelSessionFirst.ChannelSessionFirst;
  const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
  const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
  const delivery = yield* ChannelDeliveryWorker.ChannelDeliveryWorker;
  const wake = yield* ChannelWake.ChannelWake;
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

  const expireOverdue = Effect.fn("ChannelRuntime.expireOverdue")(function* () {
    const clock = yield* DateTime.now;
    const now = DateTime.formatIso(clock);
    const cutoff = DateTime.formatIso(
      DateTime.subtractDuration(clock, Duration.millis(REPLY_DEADLINE_MS)),
    );
    const overdue = yield* sql<{ readonly input_id: ChannelInputId }>`
      SELECT input_id FROM channel_inbox
      WHERE state IN ('accepted', 'processing') AND accepted_at <= ${cutoff}
        AND (reception_id IS NULL OR (reception_id NOT LIKE 'channel-session:%' AND reception_id NOT LIKE 'channel-session-ack:%'))
      ORDER BY accepted_at, rowid
    `.pipe(
      Effect.mapError(
        (cause) =>
          new ChannelLedger.ChannelLedgerError({
            reason: "persistence",
            detail: "list overdue channel inputs",
            cause,
          }),
      ),
    );
    let expired = yield* sessionFirst.deadlines(owner);
    yield* ledger.expireReceipts({ owner, now });
    for (const { input_id: inputId } of overdue) {
      const receptionId = ChannelReceptionId.make("channel-reception:" + NodeCrypto.randomUUID());
      const taken = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const stored = yield* ledger.beginReception({
              owner,
              inputId,
              receptionId,
              readAt: now,
            });
            if (stored === undefined) return false;
            const causeKey = "reply:" + inputId;
            const deliveryId = deliveryIdFor(causeKey);
            const destination = stored.message.replyAddress;
            const actor = stored.message.actor.externalActorId;
            const text = CHANNEL_COPY.receptionFailedBecause.timeout;
            return yield* ledger.failReception({
              owner,
              inputId,
              receptionId,
              failure: { reason: "reception_failed", message: text },
              deliveries: [
                {
                  deliveryId,
                  causeKey,
                  inputId,
                  message: {
                    deliveryId,
                    destination,
                    kind: "failure",
                    text,
                    inReplyToInputId: inputId,
                    ...(destination.kind === "slack" && actor !== undefined
                      ? { mentionActorId: actor }
                      : {}),
                  },
                },
              ],
              now,
            });
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isChannelLedgerError(cause)
              ? cause
              : new ChannelLedger.ChannelLedgerError({
                  reason: "persistence",
                  detail: "expire channel input",
                  cause,
                }),
          ),
        );
      if (!taken) continue;
      expired += 1;
      const fiber = (yield* Ref.get(inFlight)).get(inputId);
      // A slow finalizer must not delay the remaining inputs' deadline commits.
      if (fiber !== undefined) yield* Fiber.interrupt(fiber).pipe(Effect.forkIn(scope));
    }
    if (expired > 0) yield* wake.wake;
    return expired;
  });

  const deliverReceipts = Effect.fn("ChannelRuntime.deliverReceipts")(function* () {
    const delivered = yield* delivery.deliverReceipts(owner);
    if (delivered > 0) yield* wake.wake;
    return delivered;
  });

  const runPass = Effect.gen(function* () {
    if ((yield* hold.current) !== null) return 0;
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
      if ((yield* sessionFirst.offer(inputId, owner)) || (yield* startReception(inputId)))
        started += 1;
    }
    // Oldest request first, so work held back by the per-person cap starts in arrival order.
    const waiting = (yield* ledger.listTasksByStatus(["received", "dispatching"])).toSorted(
      (left, right) => left.task.createdAt.localeCompare(right.task.createdAt),
    );
    for (const stored of waiting) {
      // The acknowledgement goes out before the work starts: while its delivery could still
      // reach the person, the task waits at received until that delivery settles.
      if (stored.task.status === "received") {
        const input =
          stored.task.kind === "turn"
            ? yield* ledger.getInput(stored.task.originInputId)
            : undefined;
        const unsettled = isSessionClaim(input?.snapshot.receptionId)
          ? Effect.succeed(false)
          : stored.task.kind === "turn"
            ? readReceiptSettlement(sql, stored.task.originInputId).pipe(
                Effect.map((settled) => !settled),
              )
            : hasUnsettledChannelDelivery(sql, stored.task.originInputId);
        if (yield* unsettled) continue;
      }
      yield* dispatcher.dispatch(stored.task.taskId, owner);
      started += 1;
    }
    yield* sessionFirst.observe(owner);
    for (const pending of yield* ledger.listPendingForwards(50)) {
      yield* dispatcher.forward(pending, owner);
      started += 1;
    }
    for (const pending of yield* ledger.listPendingNarrations(50)) {
      yield* reception.narrate(pending, owner);
      started += 1;
    }
    // Child-work records settle against their destinations in the same pass, so capacity freed
    // by a finished child is visible before worker reports check completion holds or admit more.
    started += yield* childWork.reconcile.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("channel child-work reconcile failed", { cause }).pipe(Effect.as(0)),
      ),
    );
    started += yield* reports.reconcile(owner);
    // Observers of workers on other machines run on their own fibers; this only starts missing ones.
    started += yield* remoteWorkers.ensure(owner);
    const delivered = yield* delivery.deliverDue(owner);
    if (delivered > 0) yield* wake.wake;
    return started + delivered;
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
      yield* sessionFirst.settle(inputIds);
      yield* delivery.settleReceipts;
    });

  const recover = Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* ledger.settleInterruptedDeliveries({ owner, now });
    yield* sessionFirst.observe(owner);
    yield* sessionFirst.deadlines(owner);
  });

  const drain = Effect.gen(function* () {
    if (!(yield* claim)) return;
    // A forked reception may commit work for the next pass, so stop only when nothing moved.
    for (let pass = 0; pass < 50; pass += 1) {
      const started = yield* runPass;
      const awaited = yield* awaitReceptions;
      yield* delivery.settleReceipts;
      if (started === 0 && awaited === 0) return;
    }
  });

  return ChannelRuntime.of({
    drain,
    runPass,
    expireOverdue: expireOverdue(),
    deliverReceipts: deliverReceipts(),
    settle,
    recover,
    ownerToken: owner,
  });
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
    const sessionEventStart = yield* eventSink.latestSequence();
    const hold = yield* AutomationHold.AutomationHold;
    const sessionFirst = yield* ChannelSessionFirst.ChannelSessionFirst;
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

    const deadlines = Effect.gen(function* () {
      if (!(yield* Ref.get(owning)) || (yield* hold.current) !== null) return;
      yield* runtime.expireOverdue;
      yield* runtime.deliverReceipts;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("channel reply deadline pass failed", { cause }),
      ),
    );

    const runEvents = eventSink.stream({ afterSequence: sessionEventStart }).pipe(
      Stream.runForEach((stored) =>
        Effect.gen(function* () {
          if (!(yield* Ref.get(owning)) || (yield* hold.current) !== null) return;
          yield* sessionFirst.observe(runtime.ownerToken, stored.event);
          if (yield* reports.isWorkerThread(stored.event.threadId)) yield* wake.wake;
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("channel session event observation failed", { cause }),
          ),
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("channel run event stream stopped", { cause }),
      ),
    );

    if ((yield* hold.current) !== null) {
      // Release must process copied backlog without waiting for another writer or scan.
      yield* hold.awaitRelease.pipe(Effect.andThen(wake.wake), Effect.forkScoped);
    }
    yield* heartbeat.pipe(
      Effect.repeat(Schedule.spaced(Duration.millis(HEARTBEAT_MS))),
      Effect.forkScoped,
    );
    yield* passes.pipe(Effect.forever, Effect.forkScoped);
    yield* deadlines.pipe(
      Effect.repeat(Schedule.spaced(Duration.millis(DEADLINE_SCAN_MS))),
      Effect.forkScoped,
    );
    yield* runEvents.pipe(Effect.forkScoped);
  }),
);
