import * as Alchemy from "alchemy";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Rate from "../AccountRateLimitObject.ts";
import { HOURLY_OPERATIONS, type HourlyOperation } from "../AccountLimits.ts";
import * as Inbox from "../../hooks/HookInboxObject.ts";
import * as Authorization from "../../hooks/HookDeliveryAuthorization.ts";
import { RelayAuthorizationUnavailableError } from "@goat/contracts/relayErrors";
import type { HeldHook } from "../../hooks/HookInboxStore.ts";

type Call<A> = Effect.Effect<A, never, Alchemy.RuntimeContext>;
class RestartableRate extends Cloudflare.DurableObject<
  RestartableRate,
  {
    consume: (operation: HourlyOperation) => Call<{ allowed: boolean; retryAfterSeconds: number }>;
    reset: () => Call<void>;
    instance: () => Call<string>;
  }
>()("Wp3RestartableRate") {}
const rateLayer = RestartableRate.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const inner = yield* Rate.make;
    return Effect.gen(function* () {
      const methods = yield* inner;
      const crypto = yield* Crypto.Crypto;
      const instance = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      return {
        consume: Effect.fn("PolicyFixture.consume")(function* (operation: HourlyOperation) {
          const clock = yield* Clock.Clock;
          return yield* methods.consume(operation).pipe(
            Effect.provideService(Clock.Clock, {
              currentTimeMillis: Effect.succeed(100),
              currentTimeMillisUnsafe: () => 100,
              currentTimeNanos: clock.currentTimeNanos,
              currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
              monotonicTimeNanos: clock.monotonicTimeNanos,
              monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
              sleep: (duration) => clock.sleep(duration),
            }),
          );
        }),
        reset: () => state.abort("wp3 persisted rate restart"),
        instance: () => Effect.succeed(instance),
      };
    }).pipe(Effect.provide(NodeCrypto.layer));
  }),
);

class RestartableInbox extends Cloudflare.DurableObject<
  RestartableInbox,
  {
    hold: (hook: HeldHook, baseUrl: string) => Call<boolean>;
    setMode: (mode: string) => Call<void>;
    runAlarm: () => Call<void>;
    pending: () => Call<number>;
    reset: () => Call<void>;
    instance: () => Call<string>;
  }
>()("Wp3RestartableInbox") {}
const authorizationLayer = Layer.effect(
  Authorization.HookDeliveryAuthorization,
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Authorization.HookDeliveryAuthorization.of({
      allowed: Effect.fn("PolicyFixture.hookAuthorization")(function* (owner) {
        const mode = yield* Effect.promise(() => state.raw.storage.get<string>("authorization"));
        if (mode === "unavailable")
          return yield* new RelayAuthorizationUnavailableError({
            code: "authorization_unavailable",
            traceId: "fixture",
          });
        return mode === "allowed" && owner !== undefined;
      }),
    });
  }),
);
const inboxLayer = RestartableInbox.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const inner = yield* Inbox.makeWithAuthorization(authorizationLayer);
    return Effect.gen(function* () {
      const methods = yield* inner;
      const crypto = yield* Crypto.Crypto;
      const instance = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      return {
        hold: methods.hold,
        setMode: (mode: string) =>
          Effect.promise(() => state.raw.storage.put("authorization", mode)),
        runAlarm: () => methods.alarm(),
        reset: () => state.abort("wp3 persisted inbox restart"),
        instance: () => Effect.succeed(instance),
        pending: () =>
          Effect.sync(() => {
            const row = [
              ...state.raw.storage.sql.exec("SELECT count(*) AS count FROM held_hooks"),
            ][0];
            if (typeof row?.count !== "number") throw new Error("Invalid fixture row count");
            return row.count;
          }),
      };
    }).pipe(Effect.provide(NodeCrypto.layer));
  }),
);

export class PolicyWorker extends Cloudflare.Worker<PolicyWorker, {}>()("Wp3PolicyWorker") {}
export const layer = PolicyWorker.make(
  { main: import.meta.filename, compatibility: { date: "2026-05-22", flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const rates = yield* RestartableRate;
    const inboxes = yield* RestartableInbox;
    const mobileRate = yield* Cloudflare.RateLimit("FIXTURE_MOBILE_RATE", {
      namespaceId: 1003,
      simple: { limit: 1, period: 60 },
    });
    const publishRate = yield* Cloudflare.RateLimit("FIXTURE_PUBLISH_RATE", {
      namespaceId: 1004,
      simple: { limit: 1, period: 60 },
    });
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, "http://fixture.local");
        const account = url.searchParams.get("account") ?? "fixture-account";
        const rate = rates.getByName(account);
        const inbox = inboxes.getByName(account);
        switch (url.pathname) {
          case "/mobile-rate":
            return HttpServerResponse.jsonUnsafe(yield* mobileRate.limit({ key: account }));
          case "/publish-rate":
            return HttpServerResponse.jsonUnsafe(yield* publishRate.limit({ key: account }));
          case "/rate":
            return HttpServerResponse.jsonUnsafe(
              yield* rate.consume(
                HOURLY_OPERATIONS.find((op) => op === url.searchParams.get("operation")) ??
                  "link_challenge",
              ),
            );
          case "/rate-instance":
            return HttpServerResponse.text(yield* rate.instance());
          case "/rate-reset":
            yield* rate.reset().pipe(Effect.ignoreCause);
            return HttpServerResponse.empty();
          case "/hook-mode":
            yield* inbox.setMode(url.searchParams.get("mode") ?? "stale");
            return HttpServerResponse.empty();
          case "/hook-hold":
            return HttpServerResponse.jsonUnsafe(
              yield* inbox.hold(
                {
                  id: "fixture-delivery",
                  receivedAt: DateTime.formatIso(yield* DateTime.now),
                  method: "POST",
                  rawHookId: "fixture-hook",
                  rawToken: "fixture-token",
                  hookKey: "fixture-hook",
                  query: "",
                  headers: {},
                  body: new Uint8Array([1]),
                  authorization: {
                    userId: "owner",
                    accountEpoch: 1,
                    environmentId: "env",
                    environmentPublicKey: "fixture-key",
                    incarnationId: "10000000-0000-4000-8000-000000000001",
                  },
                },
                "http://127.0.0.1:1",
              ),
            );
          case "/hook-run":
            yield* inbox.runAlarm();
            return HttpServerResponse.empty();
          case "/hook-pending":
            return HttpServerResponse.jsonUnsafe(yield* inbox.pending());
          case "/hook-instance":
            return HttpServerResponse.text(yield* inbox.instance());
          case "/hook-reset":
            yield* inbox.reset().pipe(Effect.ignoreCause);
            return HttpServerResponse.empty();
          default:
            return HttpServerResponse.empty({ status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(Layer.mergeAll(rateLayer, inboxLayer, Cloudflare.Workers.RateLimitBinding)),
  ),
);
