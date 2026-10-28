import * as HookDeliveryAuthorization from "./HookDeliveryAuthorization.ts";
import * as RelayDb from "../db.ts";
import * as Layer from "effect/Layer";
import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import type * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as HookInboxStore from "./HookInboxStore.ts";
import { sendUpstream, TUNNEL_OFFLINE_STATUS } from "./upstream.ts";

const UNREACHABLE_STATUSES = new Set([502, 503, 504, TUNNEL_OFFLINE_STATUS]);
/** Retry queue-full (429) and handling failures (500); the environment deduplicates delivery ids. */
const BUSY_STATUSES = new Set([429, 500]);
const RUN_FAILURE_RETRY_MS = 60_000;

type Call<A> = Effect.Effect<A, never, Alchemy.RuntimeContext>;

export class HookInboxObject extends Cloudflare.DurableObject<
  HookInboxObject,
  {
    /** Holds a request for `baseUrl`; false when the inbox is full and nothing was stored. */
    readonly hold: (hook: HookInboxStore.HeldHook, baseUrl: string) => Call<boolean>;
    readonly wake: (baseUrl: string) => Call<boolean>;
    readonly clear: (
      authorization?: HookDeliveryAuthorization.HookAuthorization,
      retire?: boolean,
    ) => Call<void>;
  }
>()("HookInboxObject") {}

const withInboxSpan =
  (name: string, inboxId: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.withSpan(name, { root: true, attributes: { "relay.hook.endpoint_key": inboxId } }),
    );

const deliver = Effect.fn("HookInboxObject.deliver")(function* (
  baseUrl: string,
  hook: HookInboxStore.HeldHook,
) {
  const authorization = yield* HookDeliveryAuthorization.HookDeliveryAuthorization;
  const allowed = yield* authorization.allowed(hook.authorization).pipe(Effect.result);
  if (Result.isFailure(allowed)) return "authorization_unavailable" as const;
  if (!allowed.success) return "dropped" as const;
  return yield* sendUpstream(baseUrl, hook).pipe(
    Effect.result,
    Effect.map((result) => {
      // Timeouts may have executed; retries reuse delivery IDs for environment deduplication.
      if (Result.isFailure(result)) {
        return { outcome: "unreachable" as const, reason: result.failure._tag };
      }
      if (Option.isNone(result.success))
        return { outcome: "unreachable" as const, reason: "timeout" };
      const status = result.success.value.status;
      const upstreamOutcome = result.success.value.outcome;
      const outcome: HookInboxStore.DeliveryOutcome = UNREACHABLE_STATUSES.has(status)
        ? "unreachable"
        : BUSY_STATUSES.has(status)
          ? "busy"
          : "delivered";
      return { outcome, reason: `status ${status}`, upstreamOutcome };
    }),
    Effect.tap(({ upstreamOutcome }) =>
      upstreamOutcome === undefined
        ? Effect.void
        : Effect.annotateCurrentSpan({ "relay.hook.upstream_outcome": upstreamOutcome }),
    ),
    Effect.tap(({ outcome, reason }) =>
      outcome === "delivered"
        ? Effect.void
        : Effect.logInfo("Held webhook not delivered yet", {
            outcome,
            reason,
            deliveryId: hook.id,
          }),
    ),
    Effect.map(({ outcome }) => outcome),
    Effect.provide(FetchHttpClient.layer),
  );
});

export const makeWithAuthorization = Effect.fn("HookInboxObject.makeWithAuthorization")(function* <
  R,
>(authorizationLayer: Layer.Layer<HookDeliveryAuthorization.HookDeliveryAuthorization, never, R>) {
  const state = yield* Cloudflare.DurableObjectState;
  // Only the per-object inner Effect may access storage.
  return Effect.gen(function* () {
    const authorization = yield* HookDeliveryAuthorization.HookDeliveryAuthorization;
    const layerSql = SqliteClient.layer({ storage: state.raw.storage });
    const inboxId = state.raw.id.name ?? state.raw.id.toString();
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provide(layerSql), Effect.orDie);
    yield* run(HookInboxStore.migrate);

    const scheduleBy = Effect.fn("HookInboxObject.scheduleBy")(function* (at: number) {
      if (yield* run(HookInboxStore.isClosed)) {
        yield* state.storage.deleteAlarm();
        return;
      }
      const current = yield* state.storage.getAlarm();
      if (current === null || current > at) yield* state.storage.setAlarm(at);
      if (yield* run(HookInboxStore.isClosed)) yield* state.storage.deleteAlarm();
    });

    // withInboxSpan supplies each method's root span; avoid a second wrapper span.
    return {
      hold: Effect.fnUntraced(
        function* (hook: HookInboxStore.HeldHook, baseUrl: string) {
          if (!(yield* authorization.allowed(hook.authorization).pipe(Effect.orDie))) return false;
          const dueAt = yield* run(HookInboxStore.hold(hook, baseUrl));
          yield* Effect.annotateCurrentSpan({ "relay.inbox.stored": dueAt !== null });
          if (dueAt === null) return false;
          yield* scheduleBy(dueAt);
          return true;
        },
        withInboxSpan("relay.inbox.hold", inboxId),
      ),
      wake: Effect.fnUntraced(
        function* (baseUrl: string) {
          const pending = yield* run(HookInboxStore.wake(baseUrl));
          yield* Effect.annotateCurrentSpan({ "relay.inbox.pending": pending });
          if (pending) yield* scheduleBy(yield* Clock.currentTimeMillis);
          return pending;
        },
        withInboxSpan("relay.inbox.wake", inboxId),
      ),
      clear: Effect.fnUntraced(
        function* (owner?: HookDeliveryAuthorization.HookAuthorization, retire?: boolean) {
          if (retire) {
            yield* run(HookInboxStore.close);
            yield* state.storage.deleteAlarm();
            return;
          }
          const pending = owner
            ? yield* run(HookInboxStore.clearOwned(owner))
            : (yield* run(HookInboxStore.clear), false);
          if (pending) yield* scheduleBy(yield* Clock.currentTimeMillis);
          else yield* state.storage.deleteAlarm();
        },
        withInboxSpan("relay.inbox.clear", inboxId),
      ),
      alarm: () =>
        run(
          HookInboxStore.deliverDue(deliver).pipe(
            Effect.provideService(
              HookDeliveryAuthorization.HookDeliveryAuthorization,
              authorization,
            ),
          ),
        ).pipe(
          // Backoff must not delay an earlier run requested by a concurrent wake.
          Effect.flatMap((nextAt) => (nextAt === null ? Effect.void : scheduleBy(nextAt))),
          Effect.catchCause(() =>
            Effect.logWarning("Held webhook delivery run failed", {
              errorTag: "inbox_delivery_failed",
            }).pipe(
              Effect.andThen(Effect.annotateCurrentSpan({ "relay.inbox.run_result": "failed" })),
              Effect.andThen(Clock.currentTimeMillis),
              Effect.flatMap((now) => scheduleBy(now + RUN_FAILURE_RETRY_MS)),
            ),
          ),
          withInboxSpan("relay.inbox.deliver", inboxId),
        ),
    };
  }).pipe(Effect.provide(authorizationLayer));
});
export const layer = (db: RelayDb.RelayDb["Service"]) =>
  HookInboxObject.make(
    makeWithAuthorization(
      HookDeliveryAuthorization.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, db))),
    ),
  );
