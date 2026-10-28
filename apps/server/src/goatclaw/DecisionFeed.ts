import {
  OrchestratorMcpFailure,
  type DecisionFeed as DecisionFeedValue,
  type EnvironmentId,
  type OrchestrationV2DomainEvent,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Settings from "../serverSettings.ts";
import * as Inbox from "./DecisionInbox.ts";

/** The domain events that can change an open item, its routing, or the names it shows. */
const invalidates = (event: OrchestrationV2DomainEvent) => {
  switch (event.type) {
    case "runtime-request.updated":
    case "run.created":
    case "run.updated":
    case "thread.runtime-mode-updated":
    case "thread.interaction-mode-updated":
    case "thread.metadata-updated":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
      return true;
    case "turn-item.updated":
      return (
        event.payload.type === "user_input_request" || event.payload.type === "approval_request"
      );
    case "message.updated":
      return (
        event.payload.id.startsWith("question-escalation:") ||
        event.payload.id.startsWith("decision-route:")
      );
    default:
      return false;
  }
};

/**
 * One environment-wide view of open decisions and questions for the Decisions inbox. A single
 * worker recomputes it after any relevant change, only while a client is subscribed, so the
 * work does not grow with the number of clients.
 */
export class DecisionFeed extends Context.Service<
  DecisionFeed,
  {
    readonly stream: (
      caller: Inbox.DecisionCaller,
    ) => Stream.Stream<DecisionFeedValue, OrchestratorMcpFailure>;
  }
>()("goat/goatclaw/DecisionFeed") {}

const make = Effect.gen(function* () {
  const inbox = yield* Inbox.DecisionInbox;
  const sink = yield* EventSink.EventSinkV2;
  const settings = yield* Settings.ServerSettingsService;
  const snapshot = yield* SubscriptionRef.make(Option.none<DecisionFeedValue>());
  const dirty = yield* Queue.sliding<void>(1);
  const listening = yield* Deferred.make<void>();
  let subscribers = 0;
  // Bumped when the last subscriber leaves, so a computation started before then is not published.
  let generation = 0;
  let environmentId: EnvironmentId | undefined;
  const markDirty = Queue.offer(dirty, undefined).pipe(Effect.asVoid);
  const logFailure =
    (stage: string) =>
    <E>(cause: Cause.Cause<E>) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("decision feed failed", { stage, cause });

  // Snapshots wait until the event subscription is live, so no change between them is lost.
  const listen = Effect.scoped(
    Effect.gen(function* () {
      const cursor = yield* sink.latestSequence();
      const subscribed = yield* Deferred.make<void>();
      const events = yield* sink
        .stream({
          afterSequence: cursor,
          onSubscribed: Deferred.succeed(subscribed, undefined).pipe(Effect.asVoid),
        })
        .pipe(
          Stream.filter((stored) => invalidates(stored.event)),
          Stream.runForEach(() => markDirty),
          Effect.forkScoped,
        );
      yield* Effect.raceFirst(Deferred.await(subscribed), Fiber.join(events));
      yield* Deferred.succeed(listening, undefined);
      yield* markDirty;
      yield* Fiber.join(events);
    }),
  ).pipe(
    Effect.tapCause(logFailure("events")),
    Effect.retry({
      schedule: Schedule.exponential("1 second").pipe(
        Schedule.modifyDelay(({ duration }) =>
          Effect.succeed(Duration.min(duration, Duration.seconds(4))),
        ),
      ),
    }),
  );
  const recompute = Effect.gen(function* () {
    yield* Queue.take(dirty);
    yield* Deferred.await(listening);
    const target = environmentId;
    if (subscribers === 0 || target === undefined) return;
    const started = generation;
    // A failed read keeps its invalidation: retry while anyone still watches.
    const next = yield* inbox.feedSnapshot(target).pipe(
      Effect.tapCause(logFailure("snapshot")),
      Effect.retry({
        schedule: Schedule.exponential("500 millis").pipe(
          Schedule.modifyDelay(({ duration }) =>
            Effect.succeed(Duration.min(duration, Duration.seconds(8))),
          ),
        ),
        while: () => subscribers > 0 && generation === started,
      }),
    );
    if (subscribers > 0 && generation === started)
      yield* SubscriptionRef.set(snapshot, Option.some(next));
  }).pipe(Effect.catchCause(logFailure("snapshot")), Effect.forever);

  yield* Effect.forkScoped(listen);
  yield* Effect.forkScoped(recompute);
  yield* Effect.forkScoped(Stream.runForEach(inbox.changes, () => markDirty));
  yield* Effect.forkScoped(Stream.runForEach(settings.streamChanges, () => markDirty));

  const stream = (caller: Inbox.DecisionCaller) =>
    Stream.unwrap(
      Effect.gen(function* () {
        if (caller.kind !== "client")
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "The decision feed is for GOAT clients.",
          });
        environmentId ??= caller.environmentId;
        // Counted for the stream's lifetime; the last one out drops the snapshot, so a later
        // subscriber never starts from a view computed while nobody was watching.
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            subscribers += 1;
          }).pipe(Effect.andThen(markDirty)),
          () =>
            Effect.sync(() => {
              subscribers -= 1;
            }).pipe(
              Effect.andThen(
                Effect.suspend(() =>
                  subscribers === 0
                    ? Effect.sync(() => {
                        generation += 1;
                      }).pipe(Effect.andThen(SubscriptionRef.set(snapshot, Option.none())))
                    : Effect.void,
                ),
              ),
            ),
        );
        return SubscriptionRef.changes(snapshot).pipe(
          Stream.filter(Option.isSome),
          Stream.map((value) => value.value),
          Stream.changes,
        );
      }),
    );
  return DecisionFeed.of({ stream });
});
export const layer = Layer.effect(DecisionFeed, make);
