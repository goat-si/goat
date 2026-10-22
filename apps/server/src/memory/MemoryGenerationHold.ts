/**
 * Pauses memory generation for a model whose provider rejects every request the same way,
 * such as an output schema the provider refuses or a sign-in it needs. Without it, each queued
 * summary fails on its own schedule and the same rejection repeats once per item.
 *
 * A hold belongs to one model selection on one provider version: changing the model, its
 * provider, or the provider's CLI version starts clean. Holds live in memory, so a restart allows
 * one new attempt.
 *
 * @module MemoryGenerationHold
 */
import * as M from "@goat/contracts";
import {
  classifyTextGenerationFailure,
  type TextGenerationFailureKind,
} from "@goat/provider-core/server/textGenerationUtils";
import { MemoryGenerationRunnerError } from "@goat/provider-core/server/memoryGenerationRunner";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";

/** Failures that repeat for every request until something about the provider changes. */
const DETERMINISTIC_FAILURES: ReadonlySet<TextGenerationFailureKind> = new Set([
  "schema_rejected",
  "auth",
  "unavailable",
  "rate_limited",
]);
export type MemoryGenerationHoldReason = M.MemoryGenerationHold["reason"];

/** Waits before each probe after consecutive failures; then one probe per cycle. */
const MEMORY_HOLD_PROBE_DELAYS_MS = [60_000, 600_000, 3_600_000] as const;
const MEMORY_HOLD_CYCLE_MS = 86_400_000;
/** Throttling and outages usually clear on their own, so they never wait more than an hour. */
const TRANSIENT_HOLD_CYCLE_MS = 3_600_000;
const cycleFor = (reason: MemoryGenerationHoldReason) =>
  reason === "rate_limited" || reason === "unavailable"
    ? TRANSIENT_HOLD_CYCLE_MS
    : MEMORY_HOLD_CYCLE_MS;

export interface HoldState {
  readonly reason: MemoryGenerationHoldReason;
  readonly since: number;
  readonly failures: number;
  readonly retryAt: number;
}

/** The hold after one more deterministic failure. */
function nextHold(
  previous: HoldState | undefined,
  reason: MemoryGenerationHoldReason,
  now: number,
): HoldState {
  const failures = (previous?.failures ?? 0) + 1;
  return {
    reason,
    since: previous?.since ?? now,
    failures,
    retryAt: now + (MEMORY_HOLD_PROBE_DELAYS_MS[failures - 1] ?? cycleFor(reason)),
  };
}

/** The provider call was not made because its model is held. */
export class MemoryGenerationHeld extends Schema.TaggedError<MemoryGenerationHeld>()(
  "MemoryGenerationHeld",
  { reason: Schema.String, retryAt: Schema.Number },
) {
  override get message() {
    return "Memory generation is paused for this model.";
  }
}

const isTextGenerationError = Schema.is(M.TextGenerationError);
const isRunnerError = Schema.is(MemoryGenerationRunnerError);
const isSetupError = Schema.is(M.ProviderSetupError);

const encodeKey = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Tuple([
      Schema.String,
      Schema.String,
      Schema.Array(Schema.Tuple([Schema.String, Schema.Union([Schema.String, Schema.Boolean])])),
      Schema.String,
    ]),
  ),
);

/**
 * The deterministic failure kind behind an error, looking through the cause chain. Memory
 * runners (Claude isolation, Grok, OpenCode) report a missing model or runtime as a typed
 * runner error under a free-text detail, so an unrecognized detail keeps looking.
 */
export function deterministicFailure(error: unknown): MemoryGenerationHoldReason | undefined {
  for (let current = error, depth = 0; current !== undefined && depth < 4; depth += 1) {
    if (isTextGenerationError(current)) {
      const kind = classifyTextGenerationFailure(current);
      if (DETERMINISTIC_FAILURES.has(kind)) return kind as MemoryGenerationHoldReason;
    }
    if (isRunnerError(current))
      // Every code but invalid_output repeats until the provider or its models change.
      return current.code === "invalid_output" ? undefined : "unavailable";
    // A missing install, credential or configuration stays missing until settings change.
    if (isSetupError(current))
      return classifyTextGenerationFailure(current) === "auth" ? "auth" : "unavailable";
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? current.cause
        : undefined;
  }
  return undefined;
}

export class MemoryGenerationHold extends Context.Service<
  MemoryGenerationHold,
  {
    /** The hold key: the model selection and its provider's version. */
    readonly keyFor: (selection: M.MemoryModelSelection) => Effect.Effect<string>;
    /** Whether a call for this key would be refused now. */
    readonly isHeld: (key: string) => Effect.Effect<boolean>;
    /**
     * Runs one provider call unless the key is held. A due hold lets exactly one call through as
     * the probe; its slot is released however the call ends.
     */
    readonly guard: <A, E, R>(
      key: string,
      call: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | MemoryGenerationHeld, R>;
    /** Forgets the hold for a key that is no longer in use. */
    readonly release: (key: string) => Effect.Effect<boolean>;
    /** The hold to report for a key, if any. */
    readonly status: (key: string) => Effect.Effect<M.MemoryGenerationHold | undefined>;
  }
>()("goat/memory/MemoryGenerationHold") {}

const iso = (millis: number) =>
  M.MemoryUtcTimestamp.make(DateTime.formatIso(DateTime.makeUnsafe(millis)));

export const make = Effect.gen(function* () {
  const providers = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  const holds = yield* Ref.make(new Map<string, HoldState>());
  const probing = yield* Ref.make(new Set<string>());

  const keyFor = (selection: M.MemoryModelSelection) =>
    Effect.gen(function* () {
      const version = Option.isNone(providers)
        ? null
        : ((yield* providers.value.getProviders).find(
            (provider) => provider.instanceId === selection.instanceId,
          )?.version ?? null);
      // Settings and queued work may spell the same selection differently (absent vs empty
      // options), so the key uses its parts.
      return encodeKey([
        selection.instanceId,
        selection.model,
        (selection.options ?? [])
          .map((option) => [option.id, option.value] as const)
          .toSorted(([a], [b]) => a.localeCompare(b)),
        version ?? "unknown",
      ]);
    });

  const isHeld = (key: string) =>
    Effect.gen(function* () {
      const hold = (yield* Ref.get(holds)).get(key);
      if (hold === undefined) return false;
      return (yield* Ref.get(probing)).has(key) || hold.retryAt > (yield* Clock.currentTimeMillis);
    });

  const acquire = (key: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const hold = (yield* Ref.get(holds)).get(key);
      if (hold === undefined) return { probe: false } as const;
      const claimed = yield* Ref.modify(probing, (current): [boolean, Set<string>] =>
        current.has(key) || hold.retryAt > now
          ? [false, current]
          : [true, new Set([...current, key])],
      );
      if (!claimed)
        return yield* new MemoryGenerationHeld({ reason: hold.reason, retryAt: hold.retryAt });
      return { probe: true } as const;
    });

  const settle = <A, E, R>(key: string, call: Effect.Effect<A, E, R>) =>
    call.pipe(
      Effect.tap(() => Ref.update(holds, (current) => withoutKey(current, key))),
      Effect.tapError((error) =>
        Effect.gen(function* () {
          const reason = deterministicFailure(error);
          if (reason === undefined) {
            // Any other outcome means the provider answered; per-item retries take over.
            yield* Ref.update(holds, (current) => withoutKey(current, key));
            return;
          }
          const now = yield* Clock.currentTimeMillis;
          const previous = (yield* Ref.get(holds)).get(key);
          const next = nextHold(previous, reason, now);
          yield* Ref.update(holds, (current) => new Map([...current, [key, next]]));
          // The cause is logged once per opening; probes that fail again stay quiet.
          if (previous === undefined)
            yield* Effect.logWarning("memory generation paused for this model", {
              reason,
              key,
              retryAt: iso(next.retryAt),
              cause: error,
            });
        }),
      ),
    );

  const guard = <A, E, R>(key: string, call: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      acquire(key),
      () => settle(key, call),
      (slot) =>
        slot.probe
          ? Ref.update(probing, (current) => {
              const next = new Set(current);
              next.delete(key);
              return next;
            })
          : Effect.void,
    );

  const release = (key: string) =>
    Ref.modify(holds, (current): [boolean, Map<string, HoldState>] =>
      current.has(key) ? [true, withoutKey(current, key)] : [false, current],
    );

  const status = (key: string) =>
    Ref.get(holds).pipe(
      Effect.map((current) => {
        const hold = current.get(key);
        return hold === undefined
          ? undefined
          : { reason: hold.reason, since: iso(hold.since), nextAttemptAt: iso(hold.retryAt) };
      }),
    );

  return MemoryGenerationHold.of({ keyFor, isHeld, guard, release, status });
});

const withoutKey = (current: Map<string, HoldState>, key: string) => {
  if (!current.has(key)) return current;
  const next = new Map(current);
  next.delete(key);
  return next;
};

export const layer = Layer.effect(MemoryGenerationHold, make);

/** The server's shared holds, or a private set where none is provided (isolated tests). */
export const shared = Effect.serviceOption(MemoryGenerationHold).pipe(
  Effect.flatMap(Option.match({ onNone: () => make, onSome: Effect.succeed })),
);
