import type { OpenCodexInventorySnapshot } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

const OPENCODEX_READ_WAIT = Duration.seconds(2);
export const OPENCODEX_NOT_READ: OpenCodexInventorySnapshot = {
  installed: false,
  binaries: [],
  ownership: "none",
  service: { available: false },
  runtime: { port: 10100, healthy: false, ready: false },
  link: { role: "none", available: false, links: [], childSettingsApplied: null },
  slow: true,
  notReadYet: true,
};

type Pending = Deferred.Deferred<Option.Option<OpenCodexInventorySnapshot>>;
type ReaderState = { last: OpenCodexInventorySnapshot | undefined; inflight: Pending | undefined };

export const makeHostStatusOpenCodex = Effect.fn("HostStatus.makeOpenCodexReader")(function* (
  read: Effect.Effect<OpenCodexInventorySnapshot>,
  scope: Scope.Scope,
) {
  const state = yield* Ref.make<ReaderState>({ last: undefined, inflight: undefined });
  const readOpenCodex = Effect.fn("HostStatus.readOpenCodex")(function* () {
    const pending = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const fresh = yield* Deferred.make<Option.Option<OpenCodexInventorySnapshot>>();
        const [deferred, mine] = yield* Ref.modify(
          state,
          (current): readonly [readonly [Pending, boolean], ReaderState] =>
            current.inflight
              ? [[current.inflight, false] as const, current]
              : [[fresh, true] as const, { ...current, inflight: fresh }],
        );
        if (mine)
          yield* Effect.interruptible(read).pipe(
            Effect.onExit((exit) =>
              Ref.update(state, (current) => ({
                last: Exit.isSuccess(exit) ? exit.value : current.last,
                inflight: undefined,
              })).pipe(
                Effect.andThen(
                  Deferred.succeed(
                    fresh,
                    Exit.isSuccess(exit) ? Option.some(exit.value) : Option.none(),
                  ),
                ),
                // Callers see a failed read as slow; the log keeps a defect apart from slowness.
                Effect.andThen(
                  Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
                    ? Effect.logWarning("OpenCodex inventory read failed.", exit.cause)
                    : Effect.void,
                ),
              ),
            ),
            Effect.forkIn(scope),
          );
        return deferred;
      }),
    );
    const answer = yield* Deferred.await(pending).pipe(Effect.timeoutOption(OPENCODEX_READ_WAIT));
    if (Option.isSome(answer) && Option.isSome(answer.value)) return answer.value.value;
    const { last } = yield* Ref.get(state);
    return last === undefined ? OPENCODEX_NOT_READ : { ...last, slow: true as const };
  });
  return readOpenCodex();
});
