import type {
  ComputerUseForegroundGrant,
  ComputerUseLeaseUpdate,
  ComputerUsePauseReason,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { TURN_ENDED, type Interruption, type LeaseEnd } from "./ComputerUseLeaseMessages.ts";
import type { makeLeaseFences, TakenUpdate } from "./leaseUpdateFences.ts";

export const startLeaseUpdates = Effect.fn("ComputerUseLeaseProxy.updates")(function* <E>(input: {
  readonly updates: Stream.Stream<ComputerUseLeaseUpdate, E>;
  readonly controlId: string;
  readonly fences: ReturnType<typeof makeLeaseFences>;
  readonly apps: () => ReadonlySet<string> | undefined;
  readonly foreground: () => ReadonlyArray<ComputerUseForegroundGrant>;
  readonly shared: (value: boolean) => void;
  readonly deadline: (value: number) => void;
  readonly confirm: (update: ComputerUseLeaseUpdate | undefined) => void;
  readonly lock: (effect: Effect.Effect<void>) => Effect.Effect<void>;
  readonly end: (reason: LeaseEnd) => Effect.Effect<void>;
  readonly pause: (reason: ComputerUsePauseReason) => Effect.Effect<void>;
  readonly idle: () => void;
  readonly interrupt: (reason: Interruption) => Effect.Effect<unknown>;
  readonly confirmed: Deferred.Deferred<void>;
  readonly activate: (
    update: Extract<ComputerUseLeaseUpdate, { state: "active" }>,
  ) => Effect.Effect<void>;
  readonly onApplied: ((update: ComputerUseLeaseUpdate) => Effect.Effect<void>) | undefined;
  readonly transportDropped: Effect.Effect<void>;
  readonly register: (
    receive: (update: ComputerUseLeaseUpdate | undefined) => void,
    drop: () => void,
  ) => void;
}) {
  const applying = yield* Queue.unbounded<TakenUpdate | "transport-dropped">();
  const apply = (update: ComputerUseLeaseUpdate | undefined, fence: TakenUpdate["fence"]) => {
    input.confirm(update);
    const action =
      update === undefined
        ? input.end("lost")
        : fence !== undefined && "end" in fence
          ? input.end(fence.end)
          : fence !== undefined && "pause" in fence
            ? input.pause(fence.pause)
            : update.state === "idle"
              ? Effect.sync(input.idle).pipe(
                  Effect.andThen(input.interrupt(TURN_ENDED)),
                  Effect.andThen(Deferred.succeed(input.confirmed, undefined)),
                  Effect.asVoid,
                )
              : update.state === "active"
                ? input.activate(update)
                : Effect.void;
    return input
      .lock(
        action.pipe(
          Effect.andThen(
            update === undefined ? Effect.void : (input.onApplied?.(update) ?? Effect.void),
          ),
        ),
      )
      .pipe(Effect.ensuring(Effect.sync(() => input.fences.release(fence))));
  };
  yield* Queue.take(applying).pipe(
    Effect.flatMap((item) =>
      item === "transport-dropped" ? input.transportDropped : apply(item.update, item.fence),
    ),
    Effect.forever,
    Effect.catchCause(() => input.end("lost")),
    Effect.forkScoped,
  );
  const receive = (update: ComputerUseLeaseUpdate | undefined) => {
    if (
      update?.state === "primitive-request" ||
      update?.state === "primitive-cancel" ||
      update?.state === "cursor-state"
    )
      return;
    if (update?.state === "active" && update.controlId === input.controlId)
      input.shared(update.shared === true);
    const expiry = update !== undefined && "expiresAt" in update ? update.expiresAt : undefined;
    const at = expiry === undefined ? undefined : DateTime.make(expiry);
    if (at !== undefined && Option.isSome(at)) input.deadline(DateTime.toEpochMillis(at.value));
    const fence =
      update === undefined
        ? input.fences.lost()
        : input.fences.take(update, input.apps(), input.foreground());
    Queue.offerUnsafe(applying, { update, fence });
  };
  input.register(receive, () => void Queue.offerUnsafe(applying, "transport-dropped"));
  const take = (update: ComputerUseLeaseUpdate | undefined) => Effect.sync(() => receive(update));
  yield* input.updates.pipe(
    Stream.runForEach(take),
    Effect.catchCause(() => Effect.void),
    Effect.andThen(take(undefined)),
    Effect.forkScoped,
  );
});
