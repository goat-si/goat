/** Instances sharing a login directory share credits; serialize redemptions on that directory. */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import type { ProviderConsumeResetCreditOutcome } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";

interface AccountRedemptionState {
  readonly lock: Semaphore.Semaphore;
  /** Read and written only while holding the lock. */
  pendingKey: string | null;
  holders: number;
}

export class ResetCreditCoordinator extends Context.Service<
  ResetCreditCoordinator,
  {
    /** Reuse the idempotency key until an outcome or settled failure; timeouts keep it for retry. */
    readonly redeem: <E, R>(
      accountKey: string,
      consume: (idempotencyKey: string) => Effect.Effect<ProviderConsumeResetCreditOutcome, E, R>,
      isSettled?: (error: E) => boolean,
    ) => Effect.Effect<ProviderConsumeResetCreditOutcome, E | PlatformError.PlatformError, R>;
  }
>()("goat/provider/resetCreditCoordinator") {}

/** @public */
export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  // An entry lives while a redemption holds it or an uncertain outcome keeps its idempotency key.
  const states = new Map<string, AccountRedemptionState>();
  // Links to one login directory are one account; a missing directory keeps its given path.
  const canonical = (accountKey: string) =>
    fileSystem.realPath(accountKey).pipe(Effect.orElseSucceed(() => accountKey));
  const acquire = (accountKey: string) =>
    Effect.sync(() => {
      const state = states.get(accountKey) ?? {
        lock: Semaphore.makeUnsafe(1),
        pendingKey: null,
        holders: 0,
      };
      state.holders += 1;
      states.set(accountKey, state);
      return state;
    });
  const release = (accountKey: string, state: AccountRedemptionState) =>
    Effect.sync(() => {
      state.holders -= 1;
      if (state.holders === 0 && state.pendingKey === null) states.delete(accountKey);
    });

  const redeem: ResetCreditCoordinator["Service"]["redeem"] = Effect.fn(
    "resetCreditCoordinator.redeem",
  )(function* (accountKey, consume, isSettled) {
    const key = yield* canonical(accountKey);
    return yield* Effect.acquireUseRelease(
      acquire(key),
      (state) =>
        state.lock.withPermits(1)(
          Effect.gen(function* () {
            const idempotencyKey = state.pendingKey ?? (yield* crypto.randomUUIDv4());
            state.pendingKey = idempotencyKey;
            const outcome = yield* consume(idempotencyKey).pipe(
              Effect.tapError((error) =>
                isSettled?.(error)
                  ? Effect.sync(() => {
                      state.pendingKey = null;
                    })
                  : Effect.void,
              ),
            );
            state.pendingKey = null;
            return outcome;
          }),
        ),
      (state) => release(key, state),
    );
  });

  return { redeem } satisfies ResetCreditCoordinator["Service"];
});

export const layer = Layer.effect(ResetCreditCoordinator, make);

export const layerTest = Layer.effect(
  ResetCreditCoordinator,
  Effect.gen(function* () {
    let counter = 0;
    return yield* make.pipe(
      Effect.provideService(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => {
            counter += 1;
            return new Uint8Array(size).fill(counter);
          },
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
      Effect.provide(NodeFileSystem.layer),
    );
  }),
);
