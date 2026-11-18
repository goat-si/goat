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
import * as Exit from "effect/Exit";
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
const MEMORY_HOLD_IDLE_EXPIRY_MS = 2 * MEMORY_HOLD_CYCLE_MS;
const MAX_MEMORY_HOLDS = 64;
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
  readonly lastFailedAt: number;
  readonly probing: boolean;
}

interface HoldRegistry {
  readonly entries: ReadonlyMap<string, HoldState>;
  readonly saturationLogged: boolean;
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
    lastFailedAt: now,
    probing: false,
  };
}

function expireIdleHolds(entries: HoldRegistry["entries"], now: number) {
  let pruned: Map<string, HoldState> | undefined;
  for (const [key, hold] of entries) {
    if (!hold.probing && now - hold.lastFailedAt >= MEMORY_HOLD_IDLE_EXPIRY_MS) {
      (pruned ??= new Map(entries)).delete(key);
    }
  }
  return pruned ?? entries;
}

function oldestIdleHold(entries: HoldRegistry["entries"]) {
  let oldest: { key: string; lastFailedAt: number } | undefined;
  for (const [key, hold] of entries) {
    if (!hold.probing && (oldest === undefined || hold.lastFailedAt < oldest.lastFailedAt)) {
      oldest = { key, lastFailedAt: hold.lastFailedAt };
    }
  }
  return oldest?.key;
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
    /** Forgets an idle hold for a key that is no longer in use. */
    readonly release: (key: string) => Effect.Effect<boolean>;
    /** The hold to report for a key, if any. */
    readonly status: (key: string) => Effect.Effect<M.MemoryGenerationHold | undefined>;
  }
>()("goat/memory/MemoryGenerationHold") {}

const iso = (millis: number) =>
  M.MemoryUtcTimestamp.make(DateTime.formatIso(DateTime.makeUnsafe(millis)));

export const make = Effect.gen(function* () {
  const providers = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  const holds = yield* Ref.make<HoldRegistry>({ entries: new Map(), saturationLogged: false });

  const keyFor = Effect.fn("MemoryGenerationHold.keyFor")(function* (
    selection: M.MemoryModelSelection,
  ) {
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

  const modifyHolds = <A>(update: (state: HoldRegistry, now: number) => [A, HoldRegistry]) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        Ref.modify(holds, (current) => {
          const entries = expireIdleHolds(current.entries, now);
          return update(entries === current.entries ? current : { ...current, entries }, now);
        }),
      ),
    );

  const isHeld = (key: string) =>
    modifyHolds((current, now) => {
      const hold = current.entries.get(key);
      return [hold !== undefined && (hold.probing || hold.retryAt > now), current];
    });

  const acquire = (key: string) =>
    modifyHolds<boolean | MemoryGenerationHeld>((current, now) => {
      const hold = current.entries.get(key);
      if (hold === undefined) return [false, current];
      if (hold.probing || hold.retryAt > now) {
        return [new MemoryGenerationHeld({ reason: hold.reason, retryAt: hold.retryAt }), current];
      }
      const entries = new Map(current.entries).set(key, { ...hold, probing: true });
      return [true, { ...current, entries }];
    }).pipe(
      Effect.flatMap((probe) => (typeof probe === "boolean" ? Effect.succeed(probe) : probe)),
    );

  // Settlement shares the guard's span and releases probe ownership in the same update.
  const settle = Effect.fnUntraced(function* (
    key: string,
    probe: boolean,
    exit: Exit.Exit<unknown, unknown>,
  ) {
    const error = Exit.findErrorOption(exit);
    const reason = Option.isSome(error) ? deterministicFailure(error.value) : undefined;
    if (!probe && reason === undefined) return;

    const update = yield* modifyHolds((current, now): [Effect.Effect<void>, HoldRegistry] => {
      const previous = current.entries.get(key);
      // An unheld call can finish after another call has opened a hold and a probe has claimed it.
      if (!probe && previous !== undefined) return [Effect.void, current];
      if (reason === undefined) {
        if (previous === undefined) return [Effect.void, current];
        const entries = new Map(current.entries);
        if (Exit.isSuccess(exit) || Option.isSome(error)) entries.delete(key);
        else entries.set(key, { ...previous, probing: false });
        return [Effect.void, { ...current, entries }];
      }

      const entries = new Map(current.entries);
      if (previous === undefined && entries.size >= MAX_MEMORY_HOLDS) {
        const oldest = oldestIdleHold(entries);
        if (oldest === undefined) {
          return current.saturationLogged
            ? [Effect.void, current]
            : [
                Effect.logWarning("memory generation hold capacity reached; failure will retry", {
                  capacity: MAX_MEMORY_HOLDS,
                }),
                { ...current, saturationLogged: true },
              ];
        }
        entries.delete(oldest);
      }

      const next = nextHold(previous, reason, now);
      entries.delete(key);
      entries.set(key, next);
      const log =
        previous === undefined
          ? Effect.logWarning("memory generation paused for this model", {
              reason,
              key,
              retryAt: iso(next.retryAt),
              cause: Option.getOrUndefined(error),
            })
          : Effect.void;
      return [log, { ...current, entries }];
    });
    yield* update;
  });

  const guard = Effect.fn("MemoryGenerationHold.guard")(function* <A, E, R>(
    key: string,
    call: Effect.Effect<A, E, R>,
  ) {
    return yield* Effect.acquireUseRelease(
      acquire(key),
      () => call,
      (probe, exit) => settle(key, probe, exit),
    );
  });

  const release = (key: string) =>
    modifyHolds((current) => {
      const hold = current.entries.get(key);
      if (hold === undefined || hold.probing) return [false, current];
      const entries = new Map(current.entries);
      entries.delete(key);
      return [true, { ...current, entries }];
    });

  const status = (key: string) =>
    modifyHolds((current) => {
      const hold = current.entries.get(key);
      return [
        hold === undefined
          ? undefined
          : { reason: hold.reason, since: iso(hold.since), nextAttemptAt: iso(hold.retryAt) },
        current,
      ];
    });

  return MemoryGenerationHold.of({ keyFor, isHeld, guard, release, status });
});

export const layer = Layer.effect(MemoryGenerationHold, make);

/** The server's shared holds, or a private set where none is provided (isolated tests). */
export const shared = Effect.serviceOption(MemoryGenerationHold).pipe(
  Effect.flatMap(Option.match({ onNone: () => make, onSome: Effect.succeed })),
);
