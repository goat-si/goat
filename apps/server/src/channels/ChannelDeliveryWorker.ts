/**
 * ChannelDeliveryWorker - hands committed outbox rows to their transports.
 *
 * Delivery is at least once and keeps its delivery id across retries. A transport says whether
 * a failed send certainly did not arrive (`not_sent`, retried, after Retry-After for rate limits)
 * or may have (`unknown`, recorded as ambiguous and not repeated). Account and channel errors that
 * a retry cannot fix fail the row. Each row is claimed right before its send, so a restart finds at
 * most the one row that was really in flight. Rows go oldest first, and a task's later row waits for
 * its earlier ones, so a receipt goes out before its result. A claimed row whose hand-over could not
 * be recorded or released is put back by a periodic reconciliation once the database recovers.
 *
 * @module ChannelDeliveryWorker
 */
import type { ChannelGatewayError } from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";

import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import { PROGRESS_REFUSED, PROGRESS_SKIPPED } from "./channelProgressMessages.ts";
import type { ChannelProgressResult } from "./ChannelTransport.ts";
import * as ChannelWake from "./ChannelWake.ts";

/** With exponential backoff capped at five minutes, ten attempts span about thirteen minutes. */
const MAX_ATTEMPTS = 10;
/**
 * An answer decision is a local write that nothing else corrects, so it keeps retrying on the
 * normal path for longer: more attempts, up to ten minutes apart, before it fails.
 */
export const ANSWER_DECISION_ATTEMPTS = MAX_ATTEMPTS + 6;
const ANSWER_DECISION_MAX_WAIT_SECONDS = 600;
/** Edits and deletions of sent messages running at once; at the cap, claims take posts only. */
export const PROGRESS_WRITES_IN_FLIGHT = 8;
/** Rows one pass may send before it yields to the rest of the loop. */
const MAX_PER_PASS = 50;
/** A failed hand-over's release is retried this often, at most this many times, in batches. */
const RELEASE_RETRY_INTERVAL = Duration.seconds(5);
export const RELEASE_ATTEMPTS = 6;
const RELEASE_BATCH = 20;
/** Releases held for retry; beyond this a stuck row waits for reconciliation. */
const MAX_PENDING_RELEASES = 100;
/**
 * Once a release is given up, unsent rows are put back on this schedule until none is left, at most
 * a batch per run. A row must also be this old: the claim that just committed it may not be in
 * `inFlight` yet.
 */
const RECONCILE_INTERVAL = Duration.seconds(30);
const RECONCILE_BATCH = 20;
const NON_RETRYABLE = new Set([
  "not_in_channel",
  "channel_not_found",
  "invalid_auth",
  "token_revoked",
]);

/** What to record for a failed send. */
export const deliveryOutcomeFor = (
  error: ChannelGatewayError,
  attempts: number,
  now: DateTime.Utc,
  limits: { readonly maxAttempts: number; readonly maxWaitSeconds: number } = {
    maxAttempts: MAX_ATTEMPTS,
    maxWaitSeconds: 300,
  },
): ChannelLedger.ChannelDeliveryOutcome => {
  const code = error.deliveryErrorCode ?? error.reason;
  if (error.reason === "adapter_unavailable") return { type: "failed", errorCode: code };
  if (error.deliveryOutcome === "unknown") return { type: "ambiguous", errorCode: code };
  if (error.deliveryErrorCode !== undefined && NON_RETRYABLE.has(error.deliveryErrorCode)) {
    return { type: "failed", errorCode: code };
  }
  if (attempts >= limits.maxAttempts) return { type: "failed", errorCode: code };
  const waitSeconds = error.retryAfterSeconds ?? Math.min(2 ** attempts, limits.maxWaitSeconds);
  return {
    type: "retry",
    at: DateTime.formatIso(DateTime.addDuration(now, Duration.seconds(waitSeconds))),
    errorCode: code,
  };
};

/**
 * What to record for an edit or removal of a sent message. A 429 waits out Retry-After like a post;
 * any other failure ends that message's progress and is never retried.
 */
const progressOutcomeFor = (
  result: ChannelProgressResult,
  attempts: number,
  now: DateTime.Utc,
): ChannelLedger.ChannelDeliveryOutcome => {
  switch (result._tag) {
    case "done":
      return { type: "delivered" };
    case "skipped":
      return { type: "failed", errorCode: PROGRESS_SKIPPED };
    case "refused":
      return { type: "failed", errorCode: PROGRESS_REFUSED };
    case "unknown":
      return { type: "ambiguous", errorCode: PROGRESS_REFUSED };
    case "rate_limited":
      return attempts >= MAX_ATTEMPTS
        ? { type: "failed", errorCode: "rate_limited" }
        : {
            type: "retry",
            at: DateTime.formatIso(
              DateTime.addDuration(now, Duration.seconds(result.retryAfterSeconds)),
            ),
            errorCode: "rate_limited",
          };
  }
};

export class ChannelDeliveryWorker extends Context.Service<
  ChannelDeliveryWorker,
  {
    /** Sends every due row once. Returns how many rows it handled. */
    readonly deliverDue: (owner: string) => Effect.Effect<number, ChannelLedger.ChannelLedgerError>;
    readonly deliverReceipts: (
      owner: string,
    ) => Effect.Effect<number, ChannelLedger.ChannelLedgerError>;
    readonly settleReceipts: Effect.Effect<void>;
  }
>()("goat/channels/ChannelDeliveryWorker") {}

const make = Effect.gen(function* () {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const gateway = yield* ChannelGateway.ChannelGateway;
  const wake = yield* ChannelWake.ChannelWake;
  const scope = yield* Effect.scope;
  const receipts = new Set<Fiber.Fiber<void, unknown>>();
  interface PendingRelease {
    readonly owner: string;
    readonly deliveryId: ChannelLedger.ChannelStoredDelivery["deliveryId"];
    readonly attempt: number;
    tries: number;
  }
  // A row whose release failed stays delivering, which holds back only its own task's later rows.
  const pendingReleases = new Map<string, PendingRelease>();
  let releaseLoopRunning = false;
  // Rows this worker claimed and has not settled; reconciliation never takes them back. Each one is
  // a send this worker is running, so it is as bounded as those are.
  const inFlight = new Set<ChannelLedger.ChannelStoredDelivery["deliveryId"]>();
  // Progress writes running now; never more than PROGRESS_WRITES_IN_FLIGHT.
  let progressWrites = 0;
  interface PendingSettle {
    readonly owner: string;
    readonly deliveryId: ChannelLedger.ChannelStoredDelivery["deliveryId"];
    readonly attempt: number;
    readonly sentAt: string;
    readonly outcome: ChannelLedger.ChannelDeliveryOutcome;
    tries: number;
    nextAt: number;
  }
  // Local sends that reached their destination but whose settle failed; at most
  // MAX_PENDING_RELEASES, retried by later passes, never sent again.
  const pendingSettles = new Map<PendingSettle["deliveryId"], PendingSettle>();
  // When a pass next takes back local rows left delivering with no settle kept for them.
  let orphanScanAt: number | undefined;
  // Reasons the take-back scan is failing for now: each is logged once, until a scan succeeds.
  const scanFailures = new Set<string>();
  // One slot: a request made during a run asks for one more run after it.
  const reconcileRequests = yield* Queue.sliding<string>(1);

  const abandon = Effect.fn("ChannelDeliveryWorker.abandon")(function* (entry: PendingRelease) {
    yield* Effect.logWarning("channel delivery release abandoned until reconciliation", {
      deliveryId: entry.deliveryId,
      tries: entry.tries,
    });
    yield* Queue.offer(reconcileRequests, entry.owner);
  });

  /** Puts back unsent rows a given-up release left delivering, until none is left or ownership is. */
  const reconcile = Effect.fn("ChannelDeliveryWorker.reconcile")(function* (owner: string) {
    while (true) {
      yield* Effect.sleep(RECONCILE_INTERVAL);
      const now = yield* DateTime.now;
      const result = yield* ledger
        .releaseUnsentDeliveries({
          owner,
          now: DateTime.formatIso(now),
          before: DateTime.formatIso(DateTime.subtractDuration(now, RECONCILE_INTERVAL)),
          exclude: [...inFlight, ...pendingSettles.keys()],
          limit: RECONCILE_BATCH,
        })
        .pipe(Effect.result);
      if (result._tag === "Failure") {
        yield* Effect.logWarning("channel delivery reconciliation failed", {
          error: result.failure,
        });
        // A new owner's recovery settles the rows.
        if (result.failure.reason === "ownership_lost") return;
        continue;
      }
      if (result.success.released > 0) yield* wake.wake;
      if (!result.success.remaining) return;
    }
  });

  yield* Queue.take(reconcileRequests).pipe(
    Effect.flatMap(reconcile),
    Effect.catchCause((cause) =>
      Effect.logWarning("channel delivery reconciliation stopped", { cause }),
    ),
    Effect.forever,
    Effect.forkIn(scope),
  );
  const release = (entry: PendingRelease) =>
    Effect.gen(function* () {
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* ledger.recordDelivery({
        owner: entry.owner,
        deliveryId: entry.deliveryId,
        attempt: entry.attempt,
        now: at,
        outcome: {
          type: "retry",
          at: DateTime.formatIso(
            DateTime.addDuration(DateTime.makeUnsafe(at), RELEASE_RETRY_INTERVAL),
          ),
          errorCode: "unknown",
        },
      });
    });

  /** Settles one release attempt; true when the entry is finished with, either way. */
  const tryRelease = Effect.fn("ChannelDeliveryWorker.tryRelease")(function* (
    entry: PendingRelease,
  ) {
    entry.tries += 1;
    const result = yield* release(entry).pipe(Effect.result);
    if (result._tag === "Success") {
      yield* wake.wake;
      return true;
    }
    yield* Effect.logWarning("channel delivery release failed", { error: result.failure });
    // Any failure other than persistence, or a persistent one past the bound, leaves the row
    // delivering for reconciliation.
    if (result.failure.reason === "persistence" && entry.tries < RELEASE_ATTEMPTS) return false;
    yield* abandon(entry);
    return true;
  });

  const releaseLoop = Effect.gen(function* () {
    while (true) {
      if (pendingReleases.size === 0) {
        releaseLoopRunning = false;
        return;
      }
      yield* Effect.sleep(RELEASE_RETRY_INTERVAL);
      for (const entry of [...pendingReleases.values()].slice(0, RELEASE_BATCH)) {
        if (yield* tryRelease(entry)) pendingReleases.delete(entry.deliveryId);
      }
    }
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        releaseLoopRunning = false;
      }),
    ),
  );

  const holdForRelease = Effect.fn("ChannelDeliveryWorker.holdForRelease")(function* (
    entry: PendingRelease,
  ) {
    if (pendingReleases.size >= MAX_PENDING_RELEASES) {
      yield* abandon(entry);
      return;
    }
    pendingReleases.set(entry.deliveryId, entry);
    if (releaseLoopRunning) return;
    releaseLoopRunning = true;
    yield* Effect.forkIn(releaseLoop, scope);
  });

  /**
   * Records the hand-over just before an external send; a restart before it sends the row again,
   * after it the person may have seen it. False means do not send: the row is no longer this
   * claim's, or the record failed and the claim is released (now, or by the retry loop) for a
   * later pass.
   */
  const handOver = Effect.fn("ChannelDeliveryWorker.handOver")(function* (
    delivery: ChannelLedger.ChannelStoredDelivery,
    owner: string,
  ) {
    const kind = delivery.message.destination.kind;
    if (kind === "goat" || kind === "mcp") return true;
    const now = DateTime.formatIso(yield* DateTime.now);
    const claim = { owner, deliveryId: delivery.deliveryId, attempt: delivery.attempts, now };
    return yield* ledger.markSending(claim).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("channel delivery hand-over not recorded", { cause });
          const entry: PendingRelease = {
            owner,
            deliveryId: delivery.deliveryId,
            attempt: delivery.attempts,
            tries: 0,
          };
          if (!(yield* tryRelease(entry))) yield* holdForRelease(entry);
          return false;
        }),
      ),
    );
  });

  /**
   * Records how a send went. A send that reached a local destination is there for the person to
   * read, so a settle that fails is kept and retried by later passes at its original time, which
   * keeps a receipt inside its deadline; the destination is never written twice.
   */
  const settle = Effect.fn("ChannelDeliveryWorker.settle")(function* (
    delivery: ChannelLedger.ChannelStoredDelivery,
    owner: string,
    outcome: ChannelLedger.ChannelDeliveryOutcome,
    sentAt: string,
  ) {
    const input = { owner, deliveryId: delivery.deliveryId, attempt: delivery.attempts };
    const settled = yield* ledger
      .recordDelivery({ ...input, now: sentAt, outcome })
      .pipe(Effect.result);
    if (settled._tag === "Success") return;
    const kind = delivery.message.destination.kind;
    if (
      outcome.type !== "delivered" ||
      (kind !== "goat" && kind !== "mcp") ||
      settled.failure.reason === "ownership_lost"
    )
      return yield* settled.failure;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (pendingSettles.size >= MAX_PENDING_RELEASES) {
      // Past the cap the row stays delivering; a later pass takes it back and sends it again.
      yield* Effect.logWarning("channel delivery sent but not settled; too many waiting", {
        deliveryId: delivery.deliveryId,
        error: settled.failure,
      });
      orphanScanAt = Math.min(
        orphanScanAt ?? Infinity,
        now + Duration.toMillis(RECONCILE_INTERVAL),
      );
      return;
    }
    yield* Effect.logWarning("channel delivery sent but not settled; settling it again later", {
      deliveryId: delivery.deliveryId,
      error: settled.failure,
    });
    pendingSettles.set(delivery.deliveryId, {
      ...input,
      sentAt,
      outcome,
      tries: 0,
      nextAt: now + Duration.toMillis(RELEASE_RETRY_INTERVAL),
    });
  });

  /** Retries due settles: every few seconds at first, then at the reconciliation pace. */
  const retrySettles = Effect.fn("ChannelDeliveryWorker.retrySettles")(function* (owner: string) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (orphanScanAt !== undefined && orphanScanAt <= now) {
      // Taken before the query, so a request made while it runs is kept.
      orphanScanAt = undefined;
      const released = yield* ledger
        .releaseUnsentDeliveries({
          owner,
          now: DateTime.formatIso(DateTime.makeUnsafe(now)),
          before: DateTime.formatIso(
            DateTime.makeUnsafe(now - Duration.toMillis(RECONCILE_INTERVAL)),
          ),
          exclude: [...inFlight, ...pendingSettles.keys()],
          limit: RECONCILE_BATCH,
        })
        .pipe(Effect.result);
      if (released._tag === "Success") scanFailures.clear();
      else if (!scanFailures.has(released.failure.reason)) {
        scanFailures.add(released.failure.reason);
        yield* Effect.logWarning("channel delivery take-back scan failed", {
          reason: released.failure.reason,
          error: released.failure,
          retrying: released.failure.reason !== "ownership_lost",
        });
      }
      const again =
        released._tag === "Success"
          ? released.success.remaining
          : released.failure.reason !== "ownership_lost";
      if (again)
        orphanScanAt = Math.min(
          orphanScanAt ?? Infinity,
          now + Duration.toMillis(RECONCILE_INTERVAL),
        );
    }
    const due = [...pendingSettles.values()].filter((entry) => entry.nextAt <= now);
    for (const entry of due.slice(0, RELEASE_BATCH)) {
      const result = yield* ledger
        .recordDelivery({
          owner: entry.owner,
          deliveryId: entry.deliveryId,
          attempt: entry.attempt,
          now: entry.sentAt,
          outcome: entry.outcome,
        })
        .pipe(Effect.result);
      // A new owner's recovery sends the row again; a recorded settle frees the task's later rows.
      if (result._tag === "Success" || result.failure.reason === "ownership_lost") {
        pendingSettles.delete(entry.deliveryId);
        if (result._tag === "Success") yield* wake.wake;
        continue;
      }
      entry.tries += 1;
      entry.nextAt =
        now +
        Duration.toMillis(
          entry.tries < RELEASE_ATTEMPTS ? RELEASE_RETRY_INTERVAL : RECONCILE_INTERVAL,
        );
    }
  });

  const sendReceipt = Effect.fn("ChannelDeliveryWorker.sendReceipt")(function* (
    delivery: ChannelLedger.ChannelStoredDelivery,
    owner: string,
  ) {
    const clock = yield* DateTime.now;
    const remaining =
      (delivery.receiptDeadline ?? DateTime.toEpochMillis(clock)) - DateTime.toEpochMillis(clock);
    if (remaining <= 0) {
      yield* ledger.expireReceipts({ owner, now: DateTime.formatIso(clock) });
      return;
    }
    const expiry = yield* Effect.sleep(remaining).pipe(
      Effect.andThen(
        Effect.flatMap(DateTime.now, (now) =>
          ledger.expireReceipts({ owner, now: DateTime.formatIso(now) }),
        ),
      ),
      Effect.ignore,
      Effect.forkIn(scope),
    );
    if (!(yield* handOver(delivery, owner))) {
      yield* Fiber.interrupt(expiry).pipe(Effect.forkIn(scope));
      return;
    }
    const send = yield* gateway.send(delivery.message).pipe(Effect.forkIn(scope));
    const result = yield* Fiber.join(send).pipe(
      Effect.result,
      Effect.timeoutOption(Duration.millis(Math.min(4_000, remaining))),
    );
    const now = yield* DateTime.now;
    const outcome: ChannelLedger.ChannelDeliveryOutcome = Option.isNone(result)
      ? { type: "ambiguous", errorCode: "receipt_timeout" }
      : result.value._tag === "Success"
        ? { type: "delivered", externalMessageId: result.value.success.externalMessageId }
        : deliveryOutcomeFor(result.value.failure, delivery.attempts, now);
    yield* settle(delivery, owner, outcome, DateTime.formatIso(now));
    if (outcome.type !== "retry") {
      yield* Fiber.interrupt(expiry).pipe(Effect.forkIn(scope));
      // Rows held for this receipt are free now; the loop would otherwise wait for its next scan.
      yield* wake.wake;
    }
    if (Option.isNone(result)) yield* Fiber.interrupt(send).pipe(Effect.forkIn(scope));
  });

  const sendProgress = Effect.fn("ChannelDeliveryWorker.sendProgress")(function* (
    delivery: ChannelLedger.ChannelStoredDelivery,
    progress: NonNullable<ChannelLedger.ChannelStoredDelivery["progress"]>,
    owner: string,
  ) {
    if (!(yield* handOver(delivery, owner))) return;
    const externalMessageId = progress.externalMessageId;
    const result = yield* progress.operation === "delete"
      ? gateway.remove({ destination: delivery.message.destination, externalMessageId })
      : gateway.edit({ message: delivery.message, externalMessageId });
    const now = yield* DateTime.now;
    yield* ledger.recordDelivery({
      owner,
      deliveryId: delivery.deliveryId,
      attempt: delivery.attempts,
      now: DateTime.formatIso(now),
      outcome: progressOutcomeFor(result, delivery.attempts, now),
    });
  });

  /** Runs a write on its own fiber, which settleReceipts and so drain wait for. */
  const forkTracked = <E>(
    deliveryId: ChannelLedger.ChannelStoredDelivery["deliveryId"],
    work: Effect.Effect<void, E>,
    failure: string,
  ) =>
    Effect.gen(function* () {
      let fiber: Fiber.Fiber<void, unknown> | undefined;
      fiber = yield* work.pipe(
        Effect.tapCause((cause) => Effect.logWarning(failure, { cause })),
        Effect.ignore,
        Effect.ensuring(
          Effect.sync(() => {
            inFlight.delete(deliveryId);
            if (fiber !== undefined) receipts.delete(fiber);
          }),
        ),
        Effect.forkIn(scope),
      );
      receipts.add(fiber);
    });

  const deliverReceipts = Effect.fn("ChannelDeliveryWorker.deliverReceipts")(function* (
    owner: string,
  ) {
    let handled = 0;
    while (handled < MAX_PER_PASS) {
      const [row] = yield* ledger.claimDueDeliveries({
        owner,
        now: DateTime.formatIso(yield* DateTime.now),
        limit: 1,
        receiptsOnly: true,
      });
      if (row === undefined) break;
      inFlight.add(row.deliveryId);
      yield* forkTracked(row.deliveryId, sendReceipt(row, owner), "channel receipt send failed");
      handled += 1;
    }
    return handled;
  });

  const send = Effect.fn("ChannelDeliveryWorker.send")(function* (
    delivery: ChannelLedger.ChannelStoredDelivery,
    owner: string,
  ) {
    if (!(yield* handOver(delivery, owner))) return;
    const sent = yield* gateway.send(delivery.message).pipe(Effect.result);
    const finishedAt = yield* DateTime.now;
    yield* settle(
      delivery,
      owner,
      sent._tag === "Success"
        ? {
            type: "delivered",
            ...(sent.success.externalMessageId === undefined
              ? {}
              : { externalMessageId: sent.success.externalMessageId }),
          }
        : deliveryOutcomeFor(
            sent.failure,
            delivery.attempts,
            finishedAt,
            delivery.message.personAnswer === undefined
              ? undefined
              : {
                  maxAttempts: ANSWER_DECISION_ATTEMPTS,
                  maxWaitSeconds: ANSWER_DECISION_MAX_WAIT_SECONDS,
                },
          ),
      DateTime.formatIso(finishedAt),
    );
  });

  const deliverDue = Effect.fn("ChannelDeliveryWorker.deliverDue")(function* (owner: string) {
    yield* retrySettles(owner);
    let handled = yield* deliverReceipts(owner);
    while (handled < MAX_PER_PASS) {
      const claimed = yield* ledger.claimDue({
        owner,
        now: DateTime.formatIso(yield* DateTime.now),
        limit: 1,
        receiptsOnly: false,
        postsOnly: progressWrites >= PROGRESS_WRITES_IN_FLIGHT,
      });
      const [delivery] = claimed.deliveries;
      // Interim messages set aside count as work done, so a long backlog is worked off in batches.
      handled += claimed.setAside;
      if (delivery === undefined) {
        if (claimed.setAside > 0) continue;
        break;
      }
      inFlight.add(delivery.deliveryId);
      handled += 1;
      // A write to a sent message may take Slack's full timeout; it never stalls this loop.
      if (delivery.progress !== undefined) {
        progressWrites += 1;
        yield* forkTracked(
          delivery.deliveryId,
          sendProgress(delivery, delivery.progress, owner).pipe(
            // A freed slot, and the message's next write, wait on this one.
            Effect.ensuring(
              Effect.sync(() => {
                progressWrites -= 1;
              }).pipe(Effect.andThen(wake.wake)),
            ),
          ),
          "channel progress write failed",
        );
        continue;
      }
      yield* send(delivery, owner).pipe(
        Effect.ensuring(Effect.sync(() => inFlight.delete(delivery.deliveryId))),
      );
    }
    return handled;
  });

  const settleReceipts = Effect.suspend(() =>
    Effect.forEach([...receipts], (fiber) => Fiber.await(fiber), { discard: true }),
  );
  return ChannelDeliveryWorker.of({ deliverDue, deliverReceipts, settleReceipts });
});

export const layer = Layer.effect(ChannelDeliveryWorker, make);
