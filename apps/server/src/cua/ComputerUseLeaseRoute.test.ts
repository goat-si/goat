import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ComputerUsePauseReason,
  type ComputerUseCallReservation,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Queue from "effect/Queue";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
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
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

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
    attached: () => Effect.succeedNone,
    everyAppControl: () => Effect.die("unused"),
    serializeAdmission: (effect) => effect,
    currentControl: () => Effect.die("unused"),
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
    releaseApps: () => Effect.void,
    streamOpened: () => Effect.void,
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

const threadFixture = Effect.fn("LeaseRouteTest.threadFixture")(function* (
  options: { readonly livenessWindowMs?: number } = {},
) {
  const registry = yield* McpSessionRegistry.__testing.make(options).pipe(
    Effect.provideService(HttpServer.HttpServer, {
      address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
      serve: () => Effect.void,
    }),
    Effect.provideService(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:test")),
      getDescriptor: Effect.die("unused"),
    }),
    Effect.provide(NodeServices.layer),
  );
  const credential = yield* registry.issue({
    threadId,
    providerInstanceId: ProviderInstanceId.make("codex"),
  });
  const released: Array<readonly [string, string]> = [];
  const signals = yield* PubSub.unbounded<void>();
  const subscribed = yield* Deferred.make<void>();
  const heldRead = yield* Ref.make<
    { reading: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | undefined
  >(undefined);
  const current = yield* Ref.make<
    | {
        controlId: string;
        state: "active" | "paused" | "idle" | "stopped";
      }
    | undefined
  >(undefined);
  const context = yield* Layer.build(
    Layer.mergeAll(
      ServerSettings.layerTest({ enableCua: true }),
      Layer.succeed(McpSessionRegistry.McpSessionRegistry, registry),
      Layer.mock(ComputerUseLeases.ComputerUseLeases)({
        releaseApps: (owner, id) => Effect.sync(() => released.push([owner, id])),
        streamOpened: () => Effect.void,
        proxy: undefined,
        currentControl: () =>
          Ref.get(current).pipe(
            Effect.map((value) =>
              value === undefined
                ? Option.none()
                : Option.some({
                    threadId,
                    controlId: value.controlId,
                    expiresAt,
                    ...(value.state === "stopped" ? { ended: "stopped" as const } : {}),
                  }),
            ),
          ),
        controlState: (_owner, id) =>
          Effect.gen(function* () {
            const value = yield* Ref.get(current);
            const held = yield* Ref.getAndSet(heldRead, undefined);
            if (held !== undefined) {
              yield* Deferred.succeed(held.reading, undefined);
              yield* Deferred.await(held.release);
            }
            if (value === undefined) return { _tag: "ended", reason: "revoked" } as const;
            if (value.controlId !== id) return { _tag: "ended", reason: "replaced" } as const;
            if (value.state === "stopped") return { _tag: "ended", reason: "stopped" } as const;
            if ((yield* Clock.currentTimeMillis) >= DateTime.toEpochMillis(expiresAt))
              return { _tag: "ended", reason: "expired" } as const;
            if (value.state === "paused") return { _tag: "paused", reason: "takeover" } as const;
            return {
              _tag: "active",
              expiresAt,
              apps: ["com.apple.calculator"],
              interruptions: { count: 0, last: "human_input" },
              wakeAt: DateTime.toEpochMillis(expiresAt),
              ...(value.state === "idle" ? ({ idle: true } as const) : {}),
            } as const;
          }),
        subscribe: PubSub.subscribe(signals).pipe(
          Effect.tap(() => Deferred.succeed(subscribed, undefined)),
        ),
      }),
    ),
  );
  const handler = yield* HttpRouter.toHttpEffect(LeaseRoute.layer);
  const request = (
    query: string,
    authorization: string | undefined = credential.config.authorizationHeader,
  ) =>
    handler.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request(`http://goat.test/api/computer-use/lease?${query}`, {
            headers: authorization === undefined ? {} : { authorization },
          }),
        ),
      ),
      Effect.provideContext(context),
    );
  const open = Effect.fn("LeaseRouteTest.open")(function* (query = `thread=${threadId}`) {
    const response = yield* request(query);
    assert.equal(response.status, 200);
    if (response.body._tag !== "Stream") return yield* Effect.die("expected lease stream");
    const updates = yield* response.body.stream.pipe(
      Stream.orDie,
      Stream.decodeText,
      Stream.splitLines,
      Stream.map((line): unknown => JSON.parse(line)),
      Stream.toQueue({ capacity: "unbounded" }),
    );
    yield* Deferred.await(subscribed);
    return Queue.take(updates).pipe(Effect.catchTags({ Done: () => Effect.undefined }));
  });
  return {
    registry,
    credential,
    request,
    open,
    released,
    holdNextRead: Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Ref.set(heldRead, { reading, release });
      return { reading: Deferred.await(reading), release: Deferred.succeed(release, undefined) };
    }),
    set: (controlId: string, state: "active" | "paused" | "idle" | "stopped" = "active") =>
      Ref.set(current, { controlId, state }).pipe(
        Effect.andThen(PubSub.publish(signals, undefined)),
      ),
  };
});

describe("computer use lease route", () => {
  it.effect("a thread stream that ends releases the app leases of the controls it followed", () =>
    Effect.gen(function* () {
      const f = yield* threadFixture();
      yield* f.set(controlId);
      // The proxy reads its first update, then goes away (exit, crash or lost connection).
      yield* Effect.scoped(
        Effect.gen(function* () {
          const next = yield* f.open();
          assert.deepEqual(yield* next, active);
        }),
      );
      assert.deepEqual(f.released, [[threadId, controlId]]);
    }),
  );

  it.effect.each(["stopped", "replaced", "revoked"] as const)(
    "%s during a suspended control read discards the older snapshot",
    (transition) =>
      Effect.gen(function* () {
        const f = yield* threadFixture();
        yield* f.set(controlId);
        const next = yield* f.open();
        assert.deepEqual(yield* next, active);
        const held = yield* f.holdNextRead;
        yield* f.set(controlId);
        yield* held.reading;
        if (transition === "revoked") yield* f.registry.revokeThread(threadId);
        else
          yield* f.set(
            transition === "replaced" ? "control:two" : controlId,
            transition === "stopped" ? "stopped" : "active",
          );
        yield* held.release;
        if (transition === "revoked") {
          assert.deepEqual(yield* next, { state: "ended", reason: "unauthorized" });
          yield* f.set("control:two");
          assert.isUndefined(yield* next);
        } else {
          assert.deepEqual(yield* next, { state: "control-ended", controlId, reason: transition });
          assert.deepEqual(
            yield* next,
            transition === "stopped"
              ? { state: "waiting" }
              : { ...active, controlId: "control:two" },
          );
        }
      }).pipe(Effect.scoped),
  );
  it.effect("one thread subscription waits, sees A stop, and follows B with its expiry", () =>
    Effect.gen(function* () {
      const f = yield* threadFixture();
      const next = yield* f.open();
      assert.deepEqual(yield* next, { state: "waiting" });
      yield* f.set(controlId);
      assert.deepEqual(yield* next, active);
      yield* f.set(controlId, "stopped");
      assert.deepEqual(yield* next, { state: "control-ended", controlId, reason: "stopped" });
      assert.deepEqual(yield* next, { state: "waiting" });
      yield* f.set("control:two");
      assert.deepEqual(yield* next, { ...active, controlId: "control:two" });
    }).pipe(Effect.scoped),
  );

  it.effect("a new current id replaces A even without observing its end", () =>
    Effect.gen(function* () {
      const f = yield* threadFixture();
      yield* f.set(controlId);
      const next = yield* f.open();
      assert.deepEqual(yield* next, active);
      yield* f.set("control:two");
      assert.deepEqual(yield* next, { state: "control-ended", controlId, reason: "replaced" });
      assert.deepEqual(yield* next, { ...active, controlId: "control:two" });
    }).pipe(Effect.scoped),
  );

  it.effect(
    "thread snapshots include expiry while paused and idle, and paused controls expire",
    () =>
      Effect.gen(function* () {
        const f = yield* threadFixture();
        yield* f.set(controlId, "idle");
        const next = yield* f.open();
        assert.deepEqual(yield* next, { state: "idle", controlId, expiresAt: active.expiresAt });
        yield* f.set(controlId, "paused");
        assert.deepEqual(yield* next, {
          state: "paused",
          controlId,
          expiresAt: active.expiresAt,
          reason: "takeover",
        });
        yield* TestClock.adjust("10 minutes");
        assert.deepEqual(yield* next, { state: "control-ended", controlId, reason: "expired" });
        assert.deepEqual(yield* next, { state: "waiting" });
      }).pipe(Effect.scoped),
  );

  it.effect("refuses wrong-thread, missing and revoked bearers and ambiguous thread options", () =>
    Effect.gen(function* () {
      const f = yield* threadFixture();
      assert.equal((yield* f.request("thread=thread:other")).status, 401);
      assert.equal((yield* f.request(`thread=${threadId}`, "")).status, 401);
      for (const query of [
        `thread=${threadId}&control=${controlId}`,
        `thread=${threadId}&mode=unknown`,
        `thread=${threadId}&thread=thread:other`,
      ])
        assert.equal((yield* f.request(query)).status, 400);
      yield* f.registry.revokeThread(threadId);
      assert.equal((yield* f.request(`thread=${threadId}`)).status, 401);
    }).pipe(Effect.scoped),
  );

  it.effect.each(["thread", "provider", "all"] as const)(
    "credential revocation by %s ends a waiting stream before B",
    (revoke) =>
      Effect.gen(function* () {
        const f = yield* threadFixture();
        const next = yield* f.open();
        assert.deepEqual(yield* next, { state: "waiting" });
        yield* revoke === "thread"
          ? f.registry.revokeThread(threadId)
          : revoke === "provider"
            ? f.registry.revokeProviderSession(f.credential.config.providerSessionId)
            : f.registry.revokeAll;
        assert.deepEqual(yield* next, { state: "ended", reason: "unauthorized" });
        yield* f.set("control:two");
        assert.isUndefined(yield* next);
      }).pipe(Effect.scoped),
  );

  it.effect("watching a credential never keeps it alive past its liveness window", () =>
    Effect.gen(function* () {
      const f = yield* threadFixture({ livenessWindowMs: 100 });
      const next = yield* f.open();
      assert.deepEqual(yield* next, { state: "waiting" });
      yield* TestClock.adjust("90 millis");
      yield* f.set(controlId);
      assert.deepEqual(yield* next, active);
      // Nothing used the credential since it was issued; the stream's own checks are not use.
      yield* TestClock.adjust("60 millis");
      yield* f.set(controlId, "paused");
      assert.deepEqual(yield* next, { state: "ended", reason: "unauthorized" });
      assert.isUndefined(
        yield* f.registry.resolve(f.credential.config.authorizationHeader.slice(7)),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("a quiet waiting stream ends when its credential expires", () =>
    Effect.gen(function* () {
      const f = yield* threadFixture({ livenessWindowMs: 100 });
      const next = yield* f.open();
      assert.deepEqual(yield* next, { state: "waiting" });
      yield* TestClock.adjust("101 millis");
      assert.deepEqual(yield* next, { state: "ended", reason: "unauthorized" });
    }).pipe(Effect.scoped),
  );

  it.effect("same-token renewal keeps the stream following controls", () =>
    Effect.gen(function* () {
      const f = yield* threadFixture();
      const next = yield* f.open();
      assert.deepEqual(yield* next, { state: "waiting" });
      const renewed = yield* f.registry.issue({
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        renew: {
          authorizationHeader: f.credential.config.authorizationHeader,
          providerSessionId: f.credential.config.providerSessionId,
        },
      });
      assert.equal(renewed.config.authorizationHeader, f.credential.config.authorizationHeader);
      yield* f.set("control:two");
      assert.deepEqual(yield* next, { ...active, controlId: "control:two" });
    }).pipe(Effect.scoped),
  );

  it.effect("the legacy GET stream still ends with its original control", () =>
    Effect.gen(function* () {
      const f = yield* threadFixture();
      yield* f.set(controlId);
      const next = yield* f.open(`control=${controlId}`);
      assert.deepEqual(yield* next, active);
      yield* f.set(controlId, "stopped");
      assert.deepEqual(yield* next, { state: "ended", reason: "stopped" });
      yield* f.set("control:two");
      assert.isUndefined(yield* next);
    }).pipe(Effect.scoped),
  );
  it.effect.each([
    [undefined, true],
    ["allowed", false],
  ] as const)(
    "a call that would move the person's pointer is refused unless the host allows it (movePointer %s)",
    ([movePointer, refused]) =>
      Effect.gen(function* () {
        const received: Array<ComputerUseCallReservation> = [];
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
              ServerSettings.ServerSettingsService.layerTest(
                movePointer === undefined ? {} : { cuaMovePointer: movePointer },
              ),
              Layer.mock(McpSessionRegistry.McpSessionRegistry)({
                resolve: (token) => Effect.succeed(token === "fixture" ? invocation : undefined),
              }),
              Layer.mock(ComputerUseLeases.ComputerUseLeases)({
                foregroundApprovalEpoch: Effect.die("unused"),
                proxy: undefined,
                callReservation: (_owner, call) =>
                  Effect.sync(() => {
                    received.push(call);
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
        const reserve = (args: object) =>
          Effect.promise(() =>
            app
              .handler(
                new Request("http://goat.test/api/computer-use/lease/calls", {
                  method: "POST",
                  body: JSON.stringify({
                    action: "reserve",
                    controlId,
                    connectionId: "driver:1",
                    callId: "one",
                    name: "click",
                    args,
                    interruptions: 0,
                    idleEpoch: 0,
                  }),
                  headers: { "content-type": "application/json", authorization: "Bearer fixture" },
                }),
              )
              .then((response) => response.json() as Promise<Record<string, unknown>>),
          );
        const foreground = yield* reserve({ pid: 42, window_id: 7, delivery_mode: "foreground" });
        assert.deepEqual(
          foreground,
          refused
            ? { status: "refused", detail: "pointer_locked" }
            : { status: "admitted", reservationId: "reservation:test" },
        );
        // A background click is judged by the leases as before, whatever the setting.
        assert.equal((yield* reserve({ pid: 42, window_id: 7, x: 3, y: 4 })).status, "admitted");
        assert.equal(received.length, refused ? 1 : 2);
      }).pipe(Effect.scoped),
  );

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
                releaseApps: () => Effect.void,
                streamOpened: () => Effect.void,
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
