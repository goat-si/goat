import { assert, describe, it } from "@effect/vitest";
import {
  type ComputerUsePauseReason,
  type ComputerUseCallReservation,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import { leaseUpdates } from "./ComputerUseLeaseRoute.ts";
import * as LeaseRoute from "./ComputerUseLeaseRoute.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";

const threadId = ThreadId.make("thread:bot");
const controlId = "control:one";
const expiresAt = DateTime.makeUnsafe(10 * 60_000);

/** Leases whose one control ends when revoked or at its expiry, and pauses on request. */
const fixture = Effect.fnUntraced(function* () {
  const revoked = yield* Ref.make(false);
  const paused = yield* Ref.make<ComputerUsePauseReason | undefined>(undefined);
  const signals = yield* PubSub.unbounded<void>();
  const leases = ComputerUseLeases.ComputerUseLeases.of({
    blocked: () => Effect.die("unused"),
    blockedTurns: Effect.die("unused"),
    active: () => Effect.succeed(Option.none()),
    holder: () => Effect.succeed(Option.none()),
    channelOrigin: () => Effect.succeed(undefined),
    state: () => Effect.die("unused"),
    control: () => Effect.die("unused"),
    everyAppControl: () => Effect.die("unused"),
    serializeAdmission: (effect) => effect,
    controlState: () =>
      Effect.gen(function* () {
        if (yield* Ref.get(revoked)) return { _tag: "ended", reason: "revoked" } as const;
        if ((yield* Clock.currentTimeMillis) >= DateTime.toEpochMillis(expiresAt))
          return { _tag: "ended", reason: "expired" } as const;
        const reason = yield* Ref.get(paused);
        if (reason !== undefined) return { _tag: "paused", reason } as const;
        return {
          _tag: "active",
          expiresAt,
          interruptions: { count: 0, last: "human_input" },
          apps: ["com.apple.calculator"],
          wakeAt: DateTime.toEpochMillis(expiresAt),
        } as const;
      }),
    stop: () => Effect.die("unused"),
    setTarget: () => Effect.die("unused"),
    callReservation: () => Effect.die("unused"),
    foregroundApprovalEpoch: Effect.die("unused"),
    approveForeground: () => Effect.die("unused"),
    foregroundAvailable: () => Effect.die("unused"),
    humanInput: () => Effect.die("unused"),
    agentInput: () => Effect.die("unused"),
    stopAll: Effect.die("unused"),
    turnEnded: () => Effect.die("unused"),
    settle: Effect.die("unused"),
    disable: Effect.die("unused"),
    grants: Effect.die("unused"),
    release: () => Effect.die("unused"),
    pause: () => Effect.die("unused"),
    detection: Effect.succeed({ humanInput: true, privateMode: true, frames: false }),
    resume: Effect.die("unused"),
    sessions: Effect.die("unused"),
    subscribe: PubSub.subscribe(signals),
    changed: PubSub.publish(signals, undefined).pipe(Effect.asVoid),
    proxy: undefined,
  });
  const settings = yield* ServerSettings.ServerSettingsService;
  const values = yield* settings.getSettings;
  const enabled = yield* Ref.make(true);
  const changes = yield* PubSub.unbounded<boolean>();
  const updates = yield* leaseUpdates({ threadId, controlId }).pipe(
    Stream.provideService(ComputerUseLeases.ComputerUseLeases, leases),
    Stream.provideService(ServerSettings.ServerSettingsService, {
      ...settings,
      getSettings: Ref.get(enabled).pipe(Effect.map((enableCua) => ({ ...values, enableCua }))),
      subscribeChanges: PubSub.subscribe(changes).pipe(
        Effect.map((subscription) =>
          Stream.fromSubscription(subscription).pipe(
            Stream.map((enableCua) => ({ ...values, enableCua })),
          ),
        ),
      ),
    }),
    Stream.toQueue({ capacity: "unbounded" }),
  );
  return {
    next: Stream.runHead(Stream.fromQueue(updates).pipe(Stream.take(1))).pipe(
      Effect.map(Option.getOrUndefined),
    ),
    revoke: Ref.set(revoked, true).pipe(Effect.andThen(leases.changed)),
    pause: (reason: ComputerUsePauseReason | undefined) =>
      Ref.set(paused, reason).pipe(Effect.andThen(leases.changed)),
    disable: Ref.set(enabled, false).pipe(Effect.andThen(PubSub.publish(changes, false))),
  };
});

const active = {
  state: "active",
  controlId,
  expiresAt: "1970-01-01T00:10:00.000Z",
  apps: ["com.apple.calculator"],
} as const;

describe("computer use lease route", () => {
  it.effect(
    "authenticates call reservations, rejects malformed requests and binds the credential's thread",
    () =>
      Effect.gen(function* () {
        const received: Array<{ threadId: ThreadId; call: ComputerUseCallReservation }> = [];
        const invocation: McpThreadInvocationScope = {
          environmentId: EnvironmentId.make("environment:test"),
          capabilities: new Set(),
          issuedAt: 0,
          requestNamespace: "test",
          client: undefined,
          thread: {
            threadId,
            providerSessionId: "provider:test",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
        };
        const routes = LeaseRoute.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              ServerSettings.layerTest(),
              Layer.mock(McpSessionRegistry.McpSessionRegistry)({
                resolve: (token) => Effect.succeed(token === "fixture" ? invocation : undefined),
              }),
              Layer.mock(ComputerUseLeases.ComputerUseLeases)({
                foregroundApprovalEpoch: Effect.die("unused"),
                proxy: undefined,
                callReservation: (owner, call) =>
                  Effect.sync(() => {
                    received.push({ threadId: owner, call });
                    return { status: "admitted", reservationId: "reservation:test" } as const;
                  }),
              }),
            ),
          ),
        );
        const app = yield* Effect.acquireRelease(
          Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
          (web) => Effect.promise(() => web.dispose()),
        );
        const request = (body: object, authorization?: string) =>
          Effect.promise(() =>
            app.handler(
              new Request("http://goat.test/api/computer-use/lease/calls", {
                method: "POST",
                body: JSON.stringify(body),
                headers: {
                  "content-type": "application/json",
                  ...(authorization ? { authorization } : {}),
                },
              }),
            ),
          );
        assert.equal((yield* request({})).status, 401);
        assert.equal((yield* request({}, "Bearer fixture")).status, 400);
        const call = {
          action: "reserve",
          controlId,
          connectionId: "driver:1",
          callId: "one",
          name: "type_text",
          args: { pid: 42, window_id: 7 },
          interruptions: 0,
          idleEpoch: 0,
        } as const;
        const response = yield* request({ ...call, threadId: "thread:forged" }, "Bearer fixture");
        assert.equal(response.status, 200);
        assert.deepEqual(received, [{ threadId, call }]);
        const validation = {
          action: "validate" as const,
          controlId,
          connectionId: "driver:1",
          reservationId: "reservation:test",
        };
        assert.equal((yield* request(validation)).status, 401);
        for (const invalid of [
          { ...validation, reservationId: "" },
          { ...validation, reservationId: null },
          { ...validation, threadId: "thread:forged" },
          { ...validation, name: "list_apps", args: {} },
        ])
          assert.equal((yield* request(invalid, "Bearer fixture")).status, 400);
        assert.equal((yield* request(validation, "Bearer fixture")).status, 200);
        assert.deepEqual(received, [
          { threadId, call },
          { threadId, call: validation },
        ]);
      }).pipe(Effect.scoped),
  );
  it.layer(ServerSettings.layerTest())("streams", (it) => {
    it.effect("pushes a revocation as soon as it is recorded", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        assert.deepEqual(yield* f.next, active);
        yield* f.revoke;
        assert.deepEqual(yield* f.next, { state: "ended", reason: "revoked" });
        // Nothing follows the line that ends the lease.
        assert.isUndefined(yield* f.next);
      }).pipe(Effect.scoped),
    );

    it.effect("holds the proxy while a person has the screen, and hands it back", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        assert.deepEqual(yield* f.next, active);
        yield* f.pause("human_input");
        assert.deepEqual(yield* f.next, { state: "paused", controlId, reason: "human_input" });
        yield* f.pause(undefined);
        assert.deepEqual(yield* f.next, active);
      }).pipe(Effect.scoped),
    );

    it.effect("ends the lease when computer use is turned off", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        assert.deepEqual(yield* f.next, active);
        yield* f.disable;
        assert.deepEqual(yield* f.next, { state: "ended", reason: "disabled" });
      }).pipe(Effect.scoped),
    );

    it.effect("ends the lease at its expiry without any other change", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        assert.deepEqual(yield* f.next, active);
        yield* TestClock.adjust("10 minutes");
        assert.deepEqual(yield* f.next, { state: "ended", reason: "expired" });
      }).pipe(Effect.scoped),
    );
  });
});
