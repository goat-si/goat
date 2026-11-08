import type { ProviderInstanceId, ProviderSessionId } from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";

/** How often a retiring session rechecks its work; it stops within one probe after the work ends. */
export const RETIRE_PROBE_MS = 5_000;
export const RETIRED_DETAIL = "The provider's settings changed; its process restarts with them.";

/** A turn cannot start on a process that still runs work under the previous settings. */
export class ProviderRestartRequiredError extends Schema.TaggedError<ProviderRestartRequiredError>()(
  "ProviderRestartRequiredError",
  { runningTurns: Schema.Number },
) {
  override get message(): string {
    const work =
      this.runningTurns === 0
        ? "an active goal or subagent"
        : `${this.runningTurns} running turn${this.runningTurns === 1 ? "" : "s"}`;
    return `This provider's settings changed. GOAT restarts it with the new settings once the work still running on its current process finishes (${work}). Stop that work to restart now, then try again.`;
  }
}

const isProviderRestartRequiredError = Schema.is(ProviderRestartRequiredError);

/** The restart-required refusal somewhere in an error's cause chain; retrying cannot clear it. */
export const restartRequiredIn = (error: unknown): ProviderRestartRequiredError | undefined => {
  let current = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth++) {
    if (isProviderRestartRequiredError(current)) return current;
    current = (current as { readonly cause?: unknown }).cause;
  }
  return undefined;
};

/** Recovers a probe failure as `fallback`; interruption still propagates. */
export const unlessInterrupted =
  <A>(fallback: A) =>
  <B, E, R>(effect: Effect.Effect<B, E, R>): Effect.Effect<A | B, E, R> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed(fallback),
      ),
    );

export interface RetirableSession {
  /** The opening adapter's settings key; sessions of adapters without one never retire. */
  readonly sessionConfigKey: string | undefined;
  readonly retiring: boolean;
  readonly busyTurns: ReadonlySet<string>;
  readonly runtime: Pick<
    ProviderAdapter.ProviderAdapterV2SessionRuntime,
    "instanceId" | "providerSessionId" | "holdsLiveWork"
  >;
}

export type Retirement = "current" | "released" | "retiring";

/**
 * Retires sessions opened under provider settings that have since changed: a session with nothing
 * running is released, one still running work is marked so it stops within a probe after the work
 * ends, and turns that would add work to it are refused by the caller.
 */
export const make = <
  Entry extends RetirableSession,
  LookupError,
  ReleaseError,
  ActivityError,
>(input: {
  readonly sessions: Ref.Ref<Map<string, Entry>>;
  readonly adapters: {
    readonly get: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<{ readonly sessionConfigKey?: string | undefined }, LookupError>;
  };
  /** Releases unless a turn is busy on the session. */
  readonly release: (providerSessionId: ProviderSessionId) => Effect.Effect<void, ReleaseError>;
  readonly reschedule: (providerSessionId: ProviderSessionId) => Effect.Effect<void, ActivityError>;
  readonly withOpenLock: <A, E, R>(
    providerSessionId: ProviderSessionId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}) => {
  const logged = (providerSessionId: ProviderSessionId) =>
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("orchestration-v2.driver-session.retire-failed", {
            providerSessionId,
            cause,
          }),
    );
  const setRetiring = (key: string, retiring: boolean) =>
    Ref.update(input.sessions, (current) => {
      const latest = current.get(key);
      if (latest === undefined) return current;
      return new Map(current).set(key, { ...latest, retiring });
    });

  /**
   * The caller holds the session's open lock, so this asks the runtime only about work it already
   * knows of; the retiring session's idle probe confirms goals with the provider outside the lock.
   */
  const retireIfStale = Effect.fn("ProviderSessionRetirement.retireIfStale")(function* (
    providerSessionId: ProviderSessionId,
  ) {
    const key = String(providerSessionId);
    // Turn starts and ends replace the entry, so every decision reads it again after a yield.
    const read = Ref.get(input.sessions).pipe(Effect.map((current) => current.get(key)));
    const opened = yield* read;
    if (opened === undefined) return "released" as Retirement;
    if (opened.sessionConfigKey === undefined) return "current";
    const current = yield* input.adapters.get(opened.runtime.instanceId).pipe(Effect.option);
    const stale =
      Option.isNone(current) || current.value.sessionConfigKey !== opened.sessionConfigKey;
    const marked = yield* read;
    if (marked === undefined) return "released";
    if (stale !== marked.retiring) {
      yield* setRetiring(key, stale);
      // Clearing goes back to the normal idle wait; setting starts the probe.
      yield* input.reschedule(providerSessionId).pipe(logged(providerSessionId));
    }
    if (!stale) return "current";
    const latest = yield* read;
    if (latest === undefined) return "released";
    if (latest.busyTurns.size > 0) return "retiring";
    const held =
      latest.runtime.holdsLiveWork !== undefined &&
      (yield* latest.runtime
        .holdsLiveWork({ pastPinCeiling: false })
        .pipe(unlessInterrupted(true)));
    if (held) return "retiring";
    yield* input.release(providerSessionId).pipe(logged(providerSessionId));
    return (yield* read) === undefined ? "released" : "retiring";
  });

  /** Rechecks every live session whenever provider instances change. */
  const follow = Effect.fn("ProviderSessionRetirement.follow")(function* (scope: Scope.Scope) {
    // Absent only in test assemblies; open still retires stale sessions it meets.
    const instances = yield* Effect.serviceOption(
      ProviderInstanceRegistry.ProviderInstanceRegistry,
    );
    if (Option.isNone(instances)) return;
    const retireAll = Effect.gen(function* () {
      for (const entry of (yield* Ref.get(input.sessions)).values()) {
        const providerSessionId = entry.runtime.providerSessionId;
        yield* input.withOpenLock(providerSessionId, retireIfStale(providerSessionId));
      }
    });
    // Subscribes before the layer finishes unless subscribing suspends; open retires what it meets.
    yield* instances.value.subscribeChanges.pipe(
      Effect.flatMap((subscription) =>
        PubSub.take(subscription).pipe(Effect.andThen(retireAll), Effect.forever),
      ),
      Scope.provide(scope),
      Effect.forkIn(scope, { startImmediately: true }),
    );
  });

  return { retireIfStale, follow };
};
