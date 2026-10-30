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
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
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
import * as ComputerUsePrimitiveChannel from "./ComputerUsePrimitiveChannel.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { makeBrowserOriginGrants } from "../preview/BrowserOriginGrants.ts";
import { BrowserOriginGrants } from "../preview/BrowserOriginGrantsLayer.ts";
import { harness, call } from "./ComputerUseLeaseProxy.testkit.ts";

const threadId = ThreadId.make("thread:bot");
const controlId = "control:one";
const expiresAt = DateTime.makeUnsafe(10 * 60_000);

/** Leases whose one control ends when revoked or at its expiry, and pauses on request. */
const fixture = Effect.fnUntraced(function* (
  grants?: BrowserOriginGrants["Service"],
  wholeScreen = false,
) {
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
    nameApps: () => Effect.die("unused"),
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
          ...(wholeScreen ? {} : { apps: ["com.apple.calculator"] }),
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
    hold: () => Effect.die("unused"),
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
    (stream) =>
      grants === undefined ? stream : Stream.provideService(stream, BrowserOriginGrants, grants),
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
  options: {
    readonly livenessWindowMs?: number;
    readonly grants?: BrowserOriginGrants["Service"];
  } = {},
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
  const leaseLayer = Layer.mock(ComputerUseLeases.ComputerUseLeases)({
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
  });
  const baseContext = yield* Layer.build(
    Layer.mergeAll(
      ServerSettings.layerTest({ enableCua: true }),
      Layer.succeed(McpSessionRegistry.McpSessionRegistry, registry),
      leaseLayer,
      ComputerUsePrimitiveChannel.layer.pipe(Layer.provide(leaseLayer)),
    ),
  );
  const context =
    options.grants === undefined
      ? baseContext
      : Context.add(baseContext, BrowserOriginGrants, options.grants);
  const handler = yield* HttpRouter.toHttpEffect(LeaseRoute.layer);
  const request = (
    query: string,
    authorization: string | undefined = credential.config.authorizationHeader,
    headers: Readonly<Record<string, string>> = {},
  ) =>
    handler.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request(`http://goat.test/api/computer-use/lease?${query}`, {
            headers: authorization === undefined ? headers : { authorization, ...headers },
          }),
        ),
      ),
      Effect.provideContext(context),
    );
  const postPrimitive = (path: string, body: object, token = "channel:secret") =>
    handler.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request(`http://goat.test/api/computer-use/lease/${path}`, {
            method: "POST",
            headers: {
              authorization: credential.config.authorizationHeader,
              "x-goat-proxy-channel": token,
            },
            body: JSON.stringify(body),
          }),
        ),
      ),
      Effect.provideContext(context),
      Effect.map((response) => response.status),
    );
  const open = Effect.fn("LeaseRouteTest.open")(function* (query = `thread=${threadId}`) {
    const response = yield* request(query);
    assert.equal(response.status, 200);
    if (response.body._tag !== "Stream") return yield* Effect.die("expected lease stream");
    const updates = yield* response.body.stream.pipe(
      Stream.orDie,
      Stream.decodeText,
      Stream.splitLines,
      // Heartbeats are blank lines every proxy skips.
      Stream.filter((line) => line.length > 0),
      Stream.map((line): unknown => JSON.parse(line)),
      Stream.toQueue({ capacity: "unbounded" }),
    );
    yield* Deferred.await(subscribed);
    return Queue.take(updates).pipe(Effect.catchTags({ Done: () => Effect.undefined }));
  });
  return {
    registry,
    credential,
    context,
    channel: Context.get(context, ComputerUsePrimitiveChannel.ComputerUsePrimitiveChannel),
    request,
    postPrimitive,
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
  it.effect("revoking a service claim makes the next proxied call refuse", () =>
    Effect.gen(function* () {
      const grants = yield* makeBrowserOriginGrants({
        environmentId: EnvironmentId.make("environment:test"),
        supported: () => true,
        publish: () => Effect.void,
        bind: () =>
          Effect.succeed({
            tabId: "tab",
            title: "Site",
            url: "https://example.test",
            driverGeneration: 1,
          }),
      });
      const request = yield* grants.request({
        threadId,
        pid: 42,
        windowId: 7,
        origin: "https://example.test",
        windowTitle: "Browser",
      });
      if (request.status !== "pending") return assert.fail("expected pending");
      yield* grants.answer(request.claimId, true);
      const stream = yield* fixture({ ...grants, reportDriverCapability: () => Effect.void }, true);
      const initial = yield* stream.next;
      if (initial?.state !== "active") return assert.fail("expected active");
      const h = yield* harness();
      yield* h.push(initial);
      yield* h.applied;
      yield* grants.revoke(threadId, "https://example.test");
      assert.deepEqual(yield* grants.claimsFor(threadId), []);
      const updated = yield* stream.next;
      if (updated?.state !== "active") return assert.fail("expected active");
      yield* h.push(updated);
      yield* h.applied;
      yield* h.send(call(1, "browser_click", { tab_id: "tab" }));
      assert.equal((yield* h.nextToProvider).id, 1);
      assert.equal(yield* h.driverQueued, 0);
    }).pipe(Effect.scoped, Effect.provide(ServerSettings.layerTest())),
  );
  it.effect(
    "enforces service claims through the control stream and ends a claim after an origin report",
    () =>
      Effect.gen(function* () {
        const grants = yield* makeBrowserOriginGrants({
          environmentId: EnvironmentId.make("environment:test"),
          supported: () => true,
          publish: () => Effect.void,
          bind: () =>
            Effect.succeed({
              tabId: "tab",
              title: "Site",
              url: "https://example.test",
              driverGeneration: 1,
            }),
        });
        const request = yield* grants.request({
          threadId,
          pid: 42,
          windowId: 7,
          origin: "https://example.test",
          windowTitle: "Browser",
        });
        if (request.status !== "pending") return assert.fail("expected pending");
        const answer = yield* grants.answer(request.claimId, true);
        if (answer.agentResult.status !== "attached") return assert.fail("expected attached");
        const service = { ...grants, reportDriverCapability: () => Effect.void };
        const stream = yield* fixture(service, true);
        const initial = yield* stream.next;
        if (initial?.state !== "active") return assert.fail("expected active");
        assert.lengthOf(initial.browserClaims ?? [], 1);
        const reports: Array<unknown> = [];
        const h = yield* harness({
          onBrowserClaimReport: (report) => {
            reports.push(report);
          },
        });
        yield* h.push(initial);
        yield* h.applied;
        yield* h.send(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }));
        yield* h.nextToDriver;
        yield* h.reply(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 99,
            result: {
              tools: [
                { name: "get_browser_state", inputSchema: { properties: { origin_scope: {} } } },
              ],
            },
          }),
        );
        yield* h.nextToProvider;
        yield* h.send(call(1, "browser_click", { tab_id: "other" }));
        assert.equal((yield* h.nextToProvider).id, 1);
        yield* h.send(
          call(2, "get_browser_state", { tab_id: "tab", origin_scope: ["https://other.test"] }),
        );
        const sent = yield* Effect.raceFirst(
          h.nextToDriver.pipe(Effect.map((message) => ({ kind: "sent" as const, message }))),
          h.nextToProvider.pipe(Effect.map((message) => ({ kind: "refused" as const, message }))),
        );
        assert.equal(sent.kind, "sent", JSON.stringify(sent.message));
        if (sent.kind !== "sent") return;
        assert.deepEqual(sent.message.params?.arguments, {
          tab_id: "tab",
          origin_scope: ["https://example.test"],
        });
        yield* h.reply(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            result: { structuredContent: { tab_id: "tab", url: "https://other.test/private" } },
          }),
        );
        assert.notInclude(JSON.stringify(yield* h.nextToProvider), "other.test");
        const ended = reports.find(
          (report) =>
            typeof report === "object" && report !== null && "browserClaimEnded" in report,
        );
        assert.isDefined(ended);
        const registry = yield* McpSessionRegistry.McpSessionRegistry.pipe(
          Effect.provide(
            Layer.mock(McpSessionRegistry.McpSessionRegistry)({
              resolve: () => Effect.succeed({ thread: { threadId } }),
            }),
          ),
        );
        const services = Context.make(McpSessionRegistry.McpSessionRegistry, registry).pipe(
          Context.add(BrowserOriginGrants, service),
        );
        const { handler, dispose } = HttpRouter.toWebHandler(LeaseRoute.reportLayer, {
          disableLogger: true,
        });
        const status = yield* Effect.promise(
          async () =>
            (
              await handler(
                new Request("http://goat.test/api/computer-use/lease", {
                  method: "POST",
                  headers: { authorization: "Bearer good" },
                  body: JSON.stringify(ended),
                }),
                services,
              )
            ).status,
        ).pipe(Effect.ensuring(Effect.promise(() => dispose())));
        assert.equal(status, 204);
        assert.equal(yield* grants.endReason(threadId, request.claimId), "origin_changed");
        const updated = yield* stream.next;
        if (updated?.state !== "active") return assert.fail("expected active");
        yield* h.push(updated);
        yield* h.applied;
        yield* h.send(call(3, "browser_click", { tab_id: "tab" }));
        assert.equal((yield* h.nextToProvider).id, 3);
        assert.equal(yield* h.driverQueued, 0);
      }).pipe(Effect.scoped, Effect.provide(ServerSettings.layerTest())),
  );
  it.effect("advertises claims through the authenticated thread stream", () =>
    Effect.gen(function* () {
      const grants = yield* makeBrowserOriginGrants({
        environmentId: EnvironmentId.make("environment:test"),
        supported: () => true,
        publish: () => Effect.void,
        bind: () =>
          Effect.succeed({
            tabId: "tab",
            title: "Site",
            url: "https://example.test",
            driverGeneration: 1,
          }),
      });
      const request = yield* grants.request({
        threadId,
        pid: 42,
        windowId: 7,
        origin: "https://example.test",
        windowTitle: "Browser",
      });
      if (request.status !== "pending") return assert.fail("expected pending");
      const answer = yield* grants.answer(request.claimId, true);
      if (answer.agentResult.status !== "attached") return assert.fail("expected attached");
      const f = yield* threadFixture({
        grants: { ...grants, reportDriverCapability: () => Effect.void },
      });
      yield* f.set(controlId);
      const next = yield* f.open();
      const initial = yield* next;
      assert.deepInclude(initial, {
        state: "active",
        claimedBrowserPids: [42],
        browserClaims: [
          {
            claimId: request.claimId,
            claimGeneration: answer.agentResult.claim.claimGeneration,
            pid: 42,
            windowId: 7,
            tabId: "tab",
            origins: ["https://example.test"],
          },
        ],
      });
      yield* grants.revoke(threadId, "https://example.test");
      const revoked = yield* next;
      assert.deepInclude(revoked, { state: "active" });
      assert.notProperty(revoked, "browserClaims");
      assert.notProperty(revoked, "claimedBrowserPids");
    }).pipe(Effect.scoped),
  );
  it.effect("advertises live claims and wakes the control stream when a claim is revoked", () =>
    Effect.gen(function* () {
      const grants = yield* makeBrowserOriginGrants({
        environmentId: EnvironmentId.make("environment:test"),
        supported: () => true,
        publish: () => Effect.void,
        bind: () =>
          Effect.succeed({
            tabId: "tab",
            title: "Site",
            url: "https://example.test",
            driverGeneration: 1,
          }),
      });
      const request = yield* grants.request({
        threadId,
        pid: 42,
        windowId: 7,
        origin: "https://example.test",
        windowTitle: "Browser",
      });
      if (request.status !== "pending") return assert.fail("expected pending");
      const answer = yield* grants.answer(request.claimId, true);
      if (answer.agentResult.status !== "attached") return assert.fail("expected attached");
      const f = yield* fixture({ ...grants, reportDriverCapability: () => Effect.void });
      const initial = yield* f.next;
      if (initial?.state !== "active") return assert.fail("expected active");
      assert.deepEqual(initial.browserClaims, [
        {
          claimId: request.claimId,
          claimGeneration: answer.agentResult.claim.claimGeneration,
          pid: 42,
          windowId: 7,
          tabId: "tab",
          origins: ["https://example.test"],
        },
      ]);
      assert.deepEqual(initial.claimedBrowserPids, [42]);
      yield* grants.revoke(threadId, "https://example.test");
      const next = yield* f.next;
      if (next?.state !== "active") return assert.fail("expected active");
      assert.isUndefined(next.browserClaims);
      assert.isUndefined(next.claimedBrowserPids);
    }).pipe(Effect.scoped, Effect.provide(ServerSettings.layerTest())),
  );
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

  it.effect(
    "stale and duplicate control-ready reports return 409; cutoff-before-ready keeps the generation tombstone",
    () =>
      Effect.gen(function* () {
        const f = yield* threadFixture();
        yield* f.set(controlId);
        yield* f.channel.issue({
          threadId,
          attachmentGeneration: "attachment:one",
          proxyChannelToken: "channel:secret",
          expiresAt: 600_000,
        });
        const response = yield* f.request(
          `control=${controlId}&primitive=1&instance=proxy:one`,
          f.credential.config.authorizationHeader,
          { "x-goat-proxy-channel": "channel:secret" },
        );
        assert.equal(response.status, 200);
        const registrationId = response.headers["x-goat-primitive-registration"];
        assert.isDefined(registrationId);
        const report = (driverGeneration: number) => ({
          registrationId,
          controlId,
          connectionId: `driver:${driverGeneration}`,
          driverGeneration,
        });
        assert.equal(yield* f.postPrimitive("primitive-control-cutoff", report(0)), 204);
        assert.equal(yield* f.postPrimitive("primitive-control-ready", report(0)), 409);
        // The control is active and its driver was cut off: the call waits for a restart.
        const unbound = yield* Effect.flip(
          f.channel.request({
            threadId,
            runId: "run:one",
            turnId: "cell:one",
            callId: 0,
            deadlineMillis: 600_000,
            tool: "click",
            args: {},
          }),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust(ComputerUsePrimitiveChannel.DRIVER_BIND_WAIT_MS);
        assert.equal((yield* Fiber.join(unbound)).reason, "desktop_not_ready");
        assert.equal(yield* f.postPrimitive("primitive-control-ready", report(1)), 204);
        assert.equal(yield* f.postPrimitive("primitive-control-ready", report(1)), 409);
        assert.equal(yield* f.postPrimitive("primitive-control-cutoff", report(0)), 204);
        assert.equal(yield* f.postPrimitive("primitive-control-ready", report(0)), 409);
        assert.equal(
          yield* f.postPrimitive("primitive-control-ready", report(2), "channel:old"),
          401,
        );
      }).pipe(Effect.scoped),
  );

  it.effect("late and duplicate primitive replies return 409 without settling another waiter", () =>
    Effect.gen(function* () {
      const f = yield* threadFixture();
      yield* f.set(controlId);
      yield* f.channel.issue({
        threadId,
        attachmentGeneration: "attachment:one",
        proxyChannelToken: "channel:secret",
        expiresAt: 600_000,
      });
      const response = yield* f.request(
        `control=${controlId}&primitive=1&instance=proxy:one`,
        f.credential.config.authorizationHeader,
        { "x-goat-proxy-channel": "channel:secret" },
      );
      const registrationId = response.headers["x-goat-primitive-registration"];
      assert.isDefined(registrationId);
      assert.equal(
        yield* f.postPrimitive("primitive-control-ready", {
          registrationId,
          controlId,
          connectionId: "driver:zero",
          driverGeneration: 0,
        }),
        204,
      );
      const waiter = yield* f.channel
        .request({
          threadId,
          runId: "run:one",
          turnId: "cell:one",
          callId: 0,
          deadlineMillis: 600_000,
          tool: "list_windows",
          args: {},
        })
        .pipe(Effect.forkChild);
      if (response.body._tag !== "Stream") throw new Error("expected stream response");
      const lines = yield* response.body.stream.pipe(
        Stream.orDie,
        Stream.decodeText,
        Stream.splitLines,
        Stream.filter((line) => line.length > 0),
        Stream.toQueue({ capacity: "unbounded" }),
      );
      yield* Queue.take(lines);
      const published = JSON.parse(yield* Queue.take(lines)) as {
        requestId: string;
        registrationId: string;
        controlId: string;
        connectionGeneration: string;
        runId: string;
        turnId: string;
        callId: number;
      };
      const reply = {
        requestId: published.requestId,
        registrationId: published.registrationId,
        controlId: published.controlId,
        connectionGeneration: published.connectionGeneration,
        runId: published.runId,
        turnId: published.turnId,
        callId: published.callId,
        status: "settled" as const,
        result: { ok: true },
      };
      assert.equal(
        yield* f.postPrimitive("primitive-replies", { ...reply, turnId: "cell:other" }),
        409,
      );
      assert.equal(yield* f.postPrimitive("primitive-replies", reply), 204);
      assert.equal((yield* Fiber.join(waiter)).status, "settled");
      assert.equal(yield* f.postPrimitive("primitive-replies", reply), 409);
    }).pipe(Effect.scoped),
  );

  it.effect("a primitive GET closes its registration when the control stream ends", () =>
    Effect.gen(function* () {
      const f = yield* threadFixture();
      yield* f.set(controlId);
      yield* f.channel.issue({
        threadId,
        attachmentGeneration: "attachment:one",
        proxyChannelToken: "channel:secret",
        expiresAt: 600_000,
      });
      const query = `control=${controlId}&primitive=1&instance=proxy:one`;
      const headers = { "x-goat-proxy-channel": "channel:secret" };
      const first = yield* f.request(query, f.credential.config.authorizationHeader, headers);
      assert.equal(first.status, 200);
      assert.equal(
        (yield* f.request(query, f.credential.config.authorizationHeader, headers)).status,
        409,
      );
      if (first.body._tag !== "Stream") throw new Error("expected stream response");
      const reader = yield* first.body.stream.pipe(Stream.orDie, Stream.runDrain, Effect.forkChild);
      yield* f.set(controlId, "stopped");
      yield* Fiber.join(reader);
      const next = yield* f.request(query, f.credential.config.authorizationHeader, headers);
      assert.equal(next.status, 409);
      const thread = yield* f.request(
        `thread=${threadId}&primitive=1&instance=proxy:two`,
        f.credential.config.authorizationHeader,
        headers,
      );
      assert.equal(thread.status, 200);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "thread-follow registration before a control refuses screen calls, then first ready delivers",
    () =>
      Effect.gen(function* () {
        const f = yield* threadFixture();
        yield* f.channel.issue({
          threadId,
          attachmentGeneration: "attachment:one",
          proxyChannelToken: "channel:secret",
          expiresAt: 600_000,
        });
        const headers = { "x-goat-proxy-channel": "channel:secret" };
        const response = yield* f.request(
          `thread=${threadId}&primitive=1&instance=proxy:one`,
          f.credential.config.authorizationHeader,
          headers,
        );
        assert.equal(response.status, 200);
        const registrationId = response.headers["x-goat-primitive-registration"];
        assert.isDefined(registrationId);
        const call = () =>
          f.channel.request({
            threadId,
            runId: "run:one",
            turnId: "cell:one",
            callId: 0,
            deadlineMillis: 600_000,
            tool: "list_windows",
            args: {},
          });
        assert.equal((yield* Effect.flip(call())).reason, "desktop_not_ready");
        yield* f.set(controlId);
        assert.isTrue(
          yield* f.channel.reportControlReady({
            threadId,
            attachmentGeneration: "attachment:one",
            proxyChannelToken: "channel:secret",
            registrationId,
            controlId,
            connectionId: "driver:zero",
            driverGeneration: 0,
          }),
        );
        const waiter = yield* call().pipe(Effect.forkChild);
        if (response.body._tag !== "Stream") throw new Error("expected stream response");
        const lines = yield* response.body.stream.pipe(
          Stream.orDie,
          Stream.decodeText,
          Stream.splitLines,
          Stream.filter((line) => line.length > 0),
          Stream.toQueue({ capacity: "unbounded" }),
        );
        const first = yield* Queue.take(lines);
        assert.include(first, '"state":"active"');
        const primitive = yield* Queue.take(lines);
        assert.include(primitive, '"state":"primitive-request"');
        const request = JSON.parse(primitive) as {
          requestId: string;
          registrationId: string;
          controlId: string;
          connectionGeneration: string;
          runId: string;
          turnId: string;
          callId: number;
        };
        assert.isTrue(
          yield* f.channel.reply({
            threadId,
            attachmentGeneration: "attachment:one",
            proxyChannelToken: "channel:secret",
            registrationId,
            reply: { ...request, status: "settled", result: { ok: true } },
          }),
        );
        assert.equal((yield* Fiber.join(waiter)).status, "settled");
      }).pipe(Effect.scoped),
  );

  it.effect("a revoked thread credential cannot register or reply with a valid channel token", () =>
    Effect.gen(function* () {
      const f = yield* threadFixture();
      yield* f.set(controlId);
      yield* f.channel.issue({
        threadId,
        attachmentGeneration: "attachment:one",
        proxyChannelToken: "channel:secret",
        expiresAt: 600_000,
      });
      const query = `control=${controlId}&primitive=1&instance=proxy:one`;
      const headers = { "x-goat-proxy-channel": "channel:secret" };
      const before = yield* f.request(query, f.credential.config.authorizationHeader, headers);
      assert.equal(before.status, 200);
      assert.isDefined(before.headers["x-goat-primitive-registration"]);
      yield* f.registry.revokeThread(threadId);
      assert.equal(
        (yield* f.request(query, f.credential.config.authorizationHeader, headers)).status,
        401,
      );
      const { handler, dispose } = HttpRouter.toWebHandler(LeaseRoute.layer, {
        disableLogger: true,
      });
      yield* Effect.promise(async () => {
        const response = await handler(
          new Request("http://goat.test/api/computer-use/lease/primitive-replies", {
            method: "POST",
            headers: { authorization: f.credential.config.authorizationHeader, ...headers },
            body: JSON.stringify({
              requestId: "request:one",
              registrationId: before.headers["x-goat-primitive-registration"],
              controlId,
              connectionGeneration: "driver:one",
              runId: "run:one",
              turnId: "cell:one",
              callId: 0,
              status: "settled",
            }),
          }),
          f.context,
        );
        assert.equal(response.status, 401);
      }).pipe(Effect.ensuring(Effect.promise(() => dispose())));
    }).pipe(Effect.scoped),
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
