// @effect-diagnostics nodeBuiltinImport:off -- FileSystem.realPath drops ".." before following links.
/** Instances sharing a login directory share credits; serialize redemptions on that directory. */
import * as NodeFSP from "node:fs/promises";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import type { ProviderConsumeResetCreditOutcome, ServerProvider } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

interface AccountRedemptionState {
  readonly lock: Semaphore.Semaphore;
  /** Read and written only while holding the lock. */
  pendingKey: string | null;
  holders: number;
}

/** Accounts tracked at once; an uncertain outcome keeps its entry until a retry settles it. */
export const MAX_TRACKED_ACCOUNTS = 64;
const MAX_LINK_HOPS = 40;

/** The OS's answer: it follows a link before the ".." after it. Missing paths are None. */
const nativeRealPath = (target: string) =>
  Effect.tryPromise({
    try: () => NodeFSP.realpath(target),
    catch: (cause) =>
      PlatformError.systemError({
        _tag:
          cause instanceof Error && "code" in cause && cause.code === "ENOENT"
            ? "NotFound"
            : "Unknown",
        module: "ResetCreditCoordinator",
        method: "canonical",
        pathOrDescriptor: target,
        cause,
      }),
  }).pipe(
    Effect.asSome,
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
  );

export class ResetCreditAccountLimitError extends Schema.TaggedError<ResetCreditAccountLimitError>()(
  "ResetCreditAccountLimitError",
  {},
) {
  override get message(): string {
    return "Too many reset-credit redemptions have an uncertain outcome. Retry those accounts first.";
  }
}

export class ResetCreditCoordinator extends Context.Service<
  ResetCreditCoordinator,
  {
    /** Reuse the idempotency key until an outcome or settled failure; timeouts keep it for retry. */
    readonly redeem: <E, R>(
      accountKey: string,
      consume: (idempotencyKey: string) => Effect.Effect<ProviderConsumeResetCreditOutcome, E, R>,
      isSettled?: (error: E) => boolean,
    ) => Effect.Effect<
      ProviderConsumeResetCreditOutcome,
      E | PlatformError.PlatformError | ResetCreditAccountLimitError,
      R
    >;
  }
>()("goat/provider/resetCreditCoordinator") {}

/** @public */
export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // An entry lives while a redemption holds it or an uncertain outcome keeps its idempotency key.
  const states = new Map<string, AccountRedemptionState>();
  // Links to one login directory are one account, including one not created yet: follow dangling
  // links, resolve the nearest existing ancestor and keep the missing tail. The path stays as
  // written (no lexical "..") because the OS follows a link before the ".." after it.
  const canonical = Effect.fn("ResetCreditCoordinator.canonical")(function* (accountKey: string) {
    let existing = path.isAbsolute(accountKey) ? accountKey : path.resolve(accountKey);
    const missing: Array<string> = [];
    let links = 0;
    while (true) {
      const real = yield* nativeRealPath(existing);
      if (Option.isSome(real)) return path.join(real.value, ...missing.toReversed());
      const target = yield* fileSystem.readLink(existing).pipe(
        Effect.asSome,
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
      );
      if (Option.isSome(target)) {
        links += 1;
        if (links > MAX_LINK_HOPS) {
          return yield* PlatformError.systemError({
            _tag: "InvalidData",
            module: "ResetCreditCoordinator",
            method: "canonical",
            description: "Too many symbolic links in the login directory path.",
            pathOrDescriptor: accountKey,
          });
        }
        existing = path.isAbsolute(target.value)
          ? target.value
          : `${path.dirname(existing)}${path.sep}${target.value}`;
        continue;
      }
      const parent = path.dirname(existing);
      if (parent === existing) return path.resolve(accountKey);
      missing.push(path.basename(existing));
      existing = parent;
    }
  });
  const acquire = (accountKey: string) =>
    Effect.suspend(() => {
      const existing = states.get(accountKey);
      if (existing === undefined && states.size >= MAX_TRACKED_ACCOUNTS) {
        return Effect.fail(new ResetCreditAccountLimitError());
      }
      const state = existing ?? { lock: Semaphore.makeUnsafe(1), pendingKey: null, holders: 0 };
      state.holders += 1;
      states.set(accountKey, state);
      return Effect.succeed(state);
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

type UsageSnapshot = Pick<ServerProvider, "usageLimits">;

/**
 * Re-probe after a redemption; true once a `reset` shows fresh limits. A failed
 * usage read republishes the pre-redemption windows, which are known stale after
 * a reset, so retry briefly instead of leaving them until the periodic check.
 */
export const refreshAfterRedemption = Effect.fn("resetCreditCoordinator.refreshAfterRedemption")(
  function* <R>(input: {
    readonly outcome: ProviderConsumeResetCreditOutcome;
    readonly getSnapshot: Effect.Effect<UsageSnapshot>;
    readonly refresh: Effect.Effect<UsageSnapshot, never, R>;
  }) {
    const before = (yield* input.getSnapshot).usageLimits?.checkedAt;
    const confirmed = ({ usageLimits }: UsageSnapshot) =>
      input.outcome !== "reset" ||
      (usageLimits !== undefined &&
        usageLimits.checkedAt !== before &&
        usageLimits.unavailable?.reason !== "probeFailed");
    return yield* input.refresh.pipe(
      Effect.map(confirmed),
      Effect.repeat({
        until: (ok) => ok,
        times: 3,
        schedule: Schedule.exponential("1 second"),
      }),
    );
  },
);

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
      Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
    );
  }),
);
