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

/** A turn cannot start on a process that still runs work under the previous settings or catalog. */
export class ProviderRestartRequiredError extends Schema.TaggedError<ProviderRestartRequiredError>()(
  "ProviderRestartRequiredError",
  { runningTurns: Schema.Number, model: Schema.optional(Schema.String) },
) {
  override get message(): string {
    if (this.model !== undefined)
      return `This provider's process started before ${this.model} was added to its model list, so it cannot run that model. Once the work still running on it finishes, sending again starts a new process that knows it. Stop that work or pick another model to continue now.`;
    const work =
      this.runningTurns === 0
        ? "an active goal, a subagent or a pending approval"
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
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        () => Effect.succeed(fallback),
      ),
    );

export interface RetirableSession {
  /** The opening adapter's settings key; sessions of adapters without one never retire. */
  readonly sessionConfigKey: string | undefined;
  readonly retiring: boolean;
  readonly busyTurns: ReadonlySet<string>;
  readonly runtime: Pick<
    ProviderAdapter.ProviderAdapterV2SessionRuntime,
    | "instanceId"
    | "providerSessionId"
    | "holdsLiveWork"
    | "hasPendingBackgroundWork"
    | "predatesModel"
  >;
}

/** `outdated`: the process predates the requested model and still runs work; nothing is marked. */
export type Retirement = "current" | "released" | "retiring" | "outdated";

/** A retiring session still takes turns from threads with a turn running on it; an outdated one refuses this turn. */
export const refuses = (retired: Retirement, threadHasRunningTurn: boolean) =>
  retired === "outdated" || (retired === "retiring" && !threadHasRunningTurn);

export const restartRequired = (retired: Retirement, runningTurns: number, model?: string) =>
  new ProviderRestartRequiredError({
    runningTurns,
    ...(retired === "outdated" && model !== undefined ? { model } : {}),
  });

/** Refuses a turn on a process, however it was opened, that predates the turn's model. */
export const refuseOutdated = Effect.fnUntraced(function* <E>(
  runtime: Pick<ProviderAdapter.ProviderAdapterV2SessionRuntime, "predatesModel">,
  model: string | undefined,
  refuse: (cause: ProviderRestartRequiredError) => E,
) {
  if (model === undefined || runtime.predatesModel === undefined) return;
  if (yield* runtime.predatesModel(model).pipe(unlessInterrupted(false)))
    return yield* Effect.fail(refuse(new ProviderRestartRequiredError({ runningTurns: 0, model })));
});

/**
 * Settings changed: an idle session is released; a busy one is marked to stop within a probe after
 * its work ends, and the caller refuses turns that would add work. A process that predates the
 * requested model is released when idle; otherwise only that turn is refused.
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
  const logged =
    (providerSessionId: ProviderSessionId) =>
    <E, R>(effect: Effect.Effect<void, E, R>) =>
      effect.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          (cause) =>
            Effect.logWarning("orchestration-v2.driver-session.retire-failed", {
              providerSessionId,
              cause,
            }),
        ),
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
    model?: string,
  ) {
    const key = String(providerSessionId);
    // Turn starts and ends replace the entry, so every decision reads it again after a yield.
    const read = Ref.get(input.sessions).pipe(Effect.map((current) => current.get(key)));
    const releaseIdle = Effect.fnUntraced(function* (busy: "retiring" | "outdated") {
      const latest = yield* read;
      if (latest === undefined) return "released" as Retirement;
      if (latest.busyTurns.size > 0) return busy;
      // Commands and tools still running in the process end with it; only a catalog restart waits.
      const working =
        busy === "outdated" &&
        latest.runtime.hasPendingBackgroundWork !== undefined &&
        (yield* latest.runtime.hasPendingBackgroundWork.pipe(unlessInterrupted(true)));
      if (working) return busy;
      const held =
        latest.runtime.holdsLiveWork !== undefined &&
        (yield* latest.runtime
          .holdsLiveWork({ pastPinCeiling: false })
          .pipe(unlessInterrupted(true)));
      if (held) return busy;
      yield* input.release(providerSessionId).pipe(logged(providerSessionId));
      return (yield* read) === undefined ? "released" : busy;
    });
    const opened = yield* read;
    if (opened === undefined) return "released" as Retirement;
    const current =
      opened.sessionConfigKey === undefined
        ? undefined
        : yield* input.adapters.get(opened.runtime.instanceId).pipe(Effect.option);
    const stale =
      current !== undefined &&
      (Option.isNone(current) || current.value.sessionConfigKey !== opened.sessionConfigKey);
    const marked = yield* read;
    if (marked === undefined) return "released";
    if (stale !== marked.retiring) {
      yield* setRetiring(key, stale);
      // Clearing goes back to the normal idle wait; setting starts the probe.
      yield* input.reschedule(providerSessionId).pipe(logged(providerSessionId));
    }
    if (stale) return yield* releaseIdle("retiring");
    const predates =
      model !== undefined &&
      marked.runtime.predatesModel !== undefined &&
      (yield* marked.runtime.predatesModel(model).pipe(unlessInterrupted(false)));
    return predates ? yield* releaseIdle("outdated") : "current";
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
