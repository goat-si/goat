import { CommandId, FLEET_LOCAL_HOST_KEY } from "@goat/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous digest keeps the key pure.
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { countHostThreads } from "../../mcp/hostStatusModel.ts";
import {
  CommitGuard,
  CommitGuardRefused,
  type CommitGuardSelector,
} from "../../orchestration-v2/goat/CommitGuard.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { FleetHostStates, LOCAL_HOST } from "../health/FleetHostStates.ts";
import {
  initialMessageCommandId,
  PlacementAdmissionEnabled,
  placementCommandId,
} from "./PlacementKey.ts";
import {
  type AdmitRefusal,
  type PlacementKey,
  PlacementReservations,
  PlacementStoreError,
  type Reservation,
} from "./PlacementReservations.ts";

const RENEW_EVERY = Duration.minutes(1);
/** How long a retry waits for the owner before it is told "unconfirmed, still pending". */
export const JoinWait = Context.Reference<Duration.Duration>("goat/fleet/admission/JoinWait", {
  defaultValue: () => Duration.seconds(20),
});
const SWEEP_EVERY = Duration.seconds(30);
const PRUNE_EVERY = Duration.hours(24);

/** What the target can say about one placement; only its reservation row decides it. */
export type PlacementAnswer =
  | {
      readonly _tag: "Started";
      readonly threadId: string;
      readonly runId: string;
      /** What the launch returned, when this call or one it joined ran it. */
      readonly launched?: unknown;
    }
  | { readonly _tag: "NotStarted"; readonly threadId: string | null; readonly reason: string }
  | { readonly _tag: "Refused"; readonly refusal: AdmitRefusal }
  | { readonly _tag: "Conflicting" }
  | { readonly _tag: "Pending" }
  | { readonly _tag: "StoreUnavailable"; readonly message: string };

export interface PlaceInput<E> {
  readonly key: PlacementKey;
  readonly digest: string;
  /** The ordinary launch with this command id; it must create the thread and its first message. */
  readonly launch: (commandId: CommandId) => Effect.Effect<unknown, E>;
}

export interface PlacementAdmissionShape {
  readonly place: <E>(input: PlaceInput<E>) => Effect.Effect<PlacementAnswer>;
  /**
   * What a request refused before admission learns from its key: null only when this key was
   * never admitted here (no row, above the watermark), so the refusal proves nothing started.
   */
  readonly unseen: (
    key: PlacementKey,
  ) => Effect.Effect<Exclude<PlacementAnswer, { readonly _tag: "Started" }> | null>;
}

export class PlacementAdmission extends Context.Service<
  PlacementAdmission,
  PlacementAdmissionShape
>()("goat/fleet/admission/PlacementAdmission") {}

const answerFromRow = (row: Reservation): PlacementAnswer =>
  row.state === "counted" && row.threadId !== null && row.runId !== null
    ? { _tag: "Started", threadId: row.threadId, runId: row.runId }
    : row.state === "fenced"
      ? { _tag: "NotStarted", threadId: row.threadId, reason: row.reason ?? "fenced" }
      : { _tag: "Pending" };

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const make = Effect.gen(function* () {
  const store = yield* PlacementReservations;
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const hostStates = yield* FleetHostStates;
  const settings = yield* ServerSettings.ServerSettingsService;
  const enabled = yield* PlacementAdmissionEnabled;
  const scope = yield* Effect.scope;
  const epoch = NodeCrypto.randomUUID();
  const lock = yield* Semaphore.make(1);
  const owners = new Map<string, Deferred.Deferred<Option.Option<unknown>>>();

  const now = Clock.currentTimeMillis;

  if (enabled) {
    // Before admission opens: launches an earlier process owned died with it.
    yield* store.fenceStale(epoch);
    yield* now.pipe(
      Effect.flatMap(store.sweep),
      Effect.catch((error) => Effect.logWarning("placement sweep failed", { error })),
      Effect.repeat(Schedule.spaced(SWEEP_EVERY)),
      Effect.forkIn(scope),
    );
    yield* now.pipe(
      Effect.flatMap(store.prune),
      Effect.catch((error) => Effect.logWarning("placement prune failed", { error })),
      Effect.repeat(Schedule.spaced(PRUNE_EVERY)),
      Effect.forkIn(scope),
    );
  }

  const live = threads.listProjectThreads({ projectId: undefined, includeSubagents: true }).pipe(
    Effect.map((shells) => {
      const counts = countHostThreads(shells);
      return counts.running + counts.queued;
    }),
    Effect.mapError((cause) => new PlacementStoreError({ operation: "live", cause })),
  );
  const cordoned = hostStates.get(LOCAL_HOST).pipe(
    Effect.map((state) => state !== null && (state.cordoned || state.draining)),
    Effect.catchDefect((cause) =>
      Effect.fail(new PlacementStoreError({ operation: "cordon", cause })),
    ),
  );
  const maxThreads = settings.getSettings.pipe(
    Effect.map((current) => current.fleet?.hosts?.[FLEET_LOCAL_HOST_KEY]?.maxThreads ?? null),
    Effect.mapError((cause) => new PlacementStoreError({ operation: "settings", cause })),
  );

  const guardFor =
    (commandId: CommandId): CommitGuardSelector =>
    (command) => {
      const refuse = (reason: string) => Effect.fail(new CommitGuardRefused({ reason }));
      if (command.commandId === commandId && command.commandType === "thread.create")
        return () =>
          store.bindThread({ commandId, epoch, threadId: command.threadId }).pipe(
            Effect.orElseSucceed(() => false),
            Effect.flatMap((bound) => (bound ? Effect.void : refuse("placement is not pending"))),
          );
      if (
        command.commandId === initialMessageCommandId(commandId) &&
        command.commandType === "message.dispatch"
      )
        return (storedEvents) => {
          const created = storedEvents.find((stored) => stored.event.type === "run.created");
          if (created?.event.type !== "run.created")
            return refuse("the first message created no run");
          return store
            .markCounted({
              commandId,
              epoch,
              threadId: command.threadId,
              runId: created.event.payload.id,
            })
            .pipe(
              Effect.orElseSucceed(() => false),
              Effect.flatMap((counted) =>
                counted ? Effect.void : refuse("placement is not pending"),
              ),
            );
        };
      // Fibers the launch forks inherit this reference; their own commands pass unguarded.
      return undefined;
    };

  /** Runs one admitted launch to its end; the reservation row, not this fiber's exit, is the outcome. */
  const own = Effect.fn("PlacementAdmission.own")(
    function* <E>(
      commandId: CommandId,
      launch: Effect.Effect<unknown, E>,
      _done: Deferred.Deferred<Option.Option<unknown>>,
    ) {
      const running = yield* launch.pipe(
        Effect.provideService(CommitGuard, guardFor(commandId)),
        Effect.exit,
        Effect.forkChild,
      );
      // A renewal that matches no row means the reservation was fenced: stop the launch.
      const renewing = yield* now.pipe(
        Effect.flatMap((at) => store.renew({ commandId, epoch, now: at })),
        // A failed renewal write proves nothing; the sweep fences a lease that really lapsed.
        Effect.catchTags({
          PlacementStoreError: (error) =>
            Effect.logWarning("placement lease renewal failed", { error }).pipe(Effect.as(true)),
        }),
        Effect.flatMap((renewed) => (renewed ? Effect.void : Fiber.interrupt(running))),
        Effect.delay(RENEW_EVERY),
        Effect.forever,
        Effect.forkChild,
      );
      // The launch's own exit; an interrupted launch interrupts this owner too.
      return yield* Fiber.join(running).pipe(Effect.ensuring(Fiber.interrupt(renewing)));
    },
    (effect, commandId, _launch, done) =>
      effect.pipe(
        Effect.onExit((exit) =>
          store
            .finalize({
              commandId,
              epoch,
              reason:
                exit._tag === "Success" && exit.value._tag === "Failure"
                  ? "launch failed: " + describe(exit.value.cause)
                  : exit._tag === "Success"
                    ? "launch ended without counting"
                    : "launch interrupted",
            })
            .pipe(
              Effect.ignore,
              Effect.andThen(
                Effect.sync(() => {
                  owners.delete(commandId);
                }),
              ),
              Effect.andThen(
                Deferred.succeed(
                  done,
                  exit._tag === "Success" && exit.value._tag === "Success"
                    ? Option.some(exit.value.value)
                    : Option.none(),
                ),
              ),
            ),
        ),
      ),
  );

  const readAnswer = (commandId: string) =>
    store
      .get(commandId)
      .pipe(
        Effect.map((row): PlacementAnswer =>
          row === null ? { _tag: "Pending" } : answerFromRow(row),
        ),
      );

  const place = Effect.fn("PlacementAdmission.place")(
    function* <E>(input: PlaceInput<E>) {
      if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
        return yield* Effect.die(
          new Error("A placed launch cannot run inside a caller's transaction."),
        );
      const commandId = placementCommandId(input.key);
      const limit = yield* maxThreads;
      const step = yield* lock.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const decision = yield* store.admit({
              key: input.key,
              commandId,
              digest: input.digest,
              epoch,
              now: yield* now,
              maxThreads: limit,
              live,
              cordoned,
            });
            switch (decision._tag) {
              case "Refused":
                return {
                  answer: { _tag: "Refused", refusal: decision.refusal } as PlacementAnswer,
                };
              case "Conflicting":
                return { answer: { _tag: "Conflicting" } as PlacementAnswer };
              case "Known": {
                if (decision.reservation.state !== "pending")
                  return { answer: answerFromRow(decision.reservation) };
                const owner = owners.get(commandId);
                if (owner !== undefined) return { wait: owner };
                // Pending with no live owner here: nothing can still commit it, so fence it.
                yield* store.finalize({ commandId, epoch, reason: "owner lost" });
                return { answer: yield* readAnswer(commandId) };
              }
              case "Admitted": {
                const done = yield* Deferred.make<Option.Option<unknown>>();
                owners.set(commandId, done);
                // Admission is uninterruptible; the launch it hands off must stay interruptible.
                yield* own(commandId, input.launch(commandId), done).pipe(
                  Effect.interruptible,
                  Effect.forkIn(scope),
                  Effect.catchCause(() =>
                    store
                      .finalize({ commandId, epoch, reason: "owner not started" })
                      .pipe(Effect.andThen(Effect.sync(() => owners.delete(commandId)))),
                  ),
                );
                return { wait: done };
              }
            }
          }),
        ),
      );
      if ("answer" in step) return step.answer;
      const finished = yield* Deferred.await(step.wait).pipe(Effect.timeoutOption(yield* JoinWait));
      if (Option.isNone(finished)) return { _tag: "Pending" } as const;
      const answer = yield* readAnswer(commandId);
      return answer._tag === "Started" && Option.isSome(finished.value)
        ? { ...answer, launched: finished.value.value }
        : answer;
    },
    Effect.catchTags({
      PlacementStoreError: (error) =>
        Effect.succeed<PlacementAnswer>({ _tag: "StoreUnavailable", message: error.message }),
    }),
  );

  const unseen = Effect.fn("PlacementAdmission.unseen")(
    function* (key: PlacementKey) {
      const { row, watermark } = yield* store.lookup(key);
      // The stored request passed these checks, so this one differs from it.
      if (row !== null) return { _tag: "Conflicting" } as const;
      if (key.issuedAt <= watermark) return { _tag: "Refused", refusal: "expired" } as const;
      return null;
    },
    Effect.catchTags({
      PlacementStoreError: (error) =>
        Effect.succeed({ _tag: "StoreUnavailable", message: error.message } as const),
    }),
  );

  return PlacementAdmission.of({ place, unseen });
});

export const layer = Layer.effect(PlacementAdmission, make);
