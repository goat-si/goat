import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import {
  type ComputerUsePauseReason,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Queue from "effect/Queue";
import * as Context from "effect/Context";
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
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { leaseUpdates } from "./ComputerUseLeaseRoute.ts";
import * as LeaseRoute from "./ComputerUseLeaseRoute.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import type { ComputerUseControlState } from "./ComputerUseControl.ts";
import * as ComputerUsePrimitiveChannel from "./ComputerUsePrimitiveChannel.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { makeTestBrowserOriginGrants as makeBrowserOriginGrants } from "../preview/BrowserOriginGrants.testkit.ts";
import { BrowserOriginGrants } from "../preview/BrowserOriginGrantsLayer.ts";
import * as Grants from "../preview/BrowserOriginGrantsLayer.ts";
import { BrowserClaimManifest } from "../preview/BrowserClaimManifest.ts";
import { harness, call } from "./ComputerUseLeaseProxy.testkit.ts";

const decodeDescriptor = Schema.decodeSync(ExecutionEnvironmentDescriptor);
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
    ownsControl: () => Effect.die("unused"),
    blocked: () => Effect.die("unused"),
    blockedTurns: Effect.die("unused"),
    active: () => Effect.succeedNone,
    holder: () => Effect.succeedNone,
    channelOrigin: () => Effect.undefined,
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
        const state: ComputerUseControlState = {
          _tag: "active",
          expiresAt,
          interruptions: { count: 0, last: "human_input" },
          apps: wholeScreen ? undefined : ["com.apple.calculator"],
          wakeAt: DateTime.toEpochMillis(expiresAt),
        };
        return state;
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
    callReservation: () =>
      Effect.succeed({ status: "admitted", reservationId: "reservation:test" } as const),
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
      Layer.effectDiscard(runMigrations()).pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
      ),
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
    reserve: (name: string, args: object) =>
      handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request("http://goat.test/api/computer-use/lease/calls", {
              method: "POST",
              headers: {
                authorization: credential.config.authorizationHeader,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                action: "reserve",
                controlId: "control:test",
                connectionId: "driver:1",
                callId: "one",
                name,
                args,
                interruptions: 0,
                idleEpoch: 0,
              }),
            }),
          ),
        ),
        Effect.provideContext(context),
        Effect.map((response): unknown =>
          response.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(response.body.body))
            : response.status,
        ),
      ),
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
  it.effect("thread capability reports cannot raise support and can lower server support", () =>
    Effect.gen(function* () {
      const grantContext = yield* Layer.build(
        Grants.layer.pipe(
          Layer.provide(
            Layer.merge(
              Layer.mock(ServerEnvironment.ServerEnvironment)({
                getDescriptor: Effect.succeed(
                  decodeDescriptor({
                    environmentId: EnvironmentId.make("environment:test"),
                    label: "Test",
                    platform: { os: "linux", arch: "x64" },
                    serverVersion: "test",
                    capabilities: { repositoryIdentity: true },
                  }),
                ),
              }),
              Layer.succeed(BrowserClaimManifest, {
                publish: () => Effect.succeed("a".repeat(64)),
                readConfig: Effect.succeed({
                  capability_manifest: {
                    sha256: "a".repeat(64),
                    file_sha256: "a".repeat(64),
                    reload_error: null,
                  },
                }),
                install: () => Effect.void,
              }),
            ),
          ),
        ),
      );
      const grants = Context.get(grantContext, BrowserOriginGrants);
      const f = yield* threadFixture({ grants });
      const handler = yield* HttpRouter.toHttpEffect(LeaseRoute.reportLayer);
      const report = (supported: boolean) =>
        handler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request("http://goat.test/api/computer-use/lease", {
                method: "POST",
                headers: { authorization: f.credential.config.authorizationHeader },
                body: JSON.stringify({ browserClaimsSupported: supported }),
              }),
            ),
          ),
          Effect.provideContext(f.context),
        );
      const input = {
        threadId,
        pid: 42,
        windowId: 7,
        origin: "https://example.test",
        windowTitle: "Browser",
      };
      assert.equal((yield* report(true)).status, 204);
      const spoofed = yield* grants.request(input);
      assert.equal(spoofed.status, "refused");
      if (spoofed.status === "refused") assert.equal(spoofed.code, "unavailable");
      yield* grants.setDriverCapability(true);
      assert.equal((yield* grants.request(input)).status, "pending");
      assert.equal((yield* report(false)).status, 204);
      const lowered = yield* grants.request(input);
      assert.equal(lowered.status, "refused");
      if (lowered.status === "refused") assert.equal(lowered.code, "unavailable");
    }).pipe(Effect.scoped),
  );
  it.effect("does not advertise a claim revoked while its change subscription is starting", () =>
    Effect.gen(function* () {
      const grants = yield* makeBrowserOriginGrants({
        environmentId: EnvironmentId.make("environment:test"),
        supported: () => true,
        publish: () => Effect.void,
        bind: () =>
          Effect.succeed({
            targetId: "target-1",
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
      const starting = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const changes = Stream.unwrap(
        Deferred.succeed(starting, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(grants.changes),
        ),
      );
      const f = yield* fixture({ ...grants, changes, setDriverCapability: () => Effect.void });
      yield* Deferred.await(starting);
      yield* grants.revoke(threadId, "https://example.test");
      yield* Deferred.succeed(release, undefined);
      const snapshot = yield* f.next;
      if (snapshot?.state !== "active") return assert.fail("expected active");
      assert.isUndefined(snapshot.browserClaims);
      assert.isUndefined(snapshot.claimedBrowserPids);
    }).pipe(Effect.scoped, Effect.provide(ServerSettings.layerTest())),
  );
  it.effect(
    "the server refuses a reservation for a claim revoked before the proxy heard of it",
    () =>
      Effect.gen(function* () {
        const grants = yield* makeBrowserOriginGrants({
          environmentId: EnvironmentId.make("environment:test"),
          supported: () => true,
          publish: () => Effect.void,
          bind: () =>
            Effect.succeed({
              targetId: "target-1",
              tabId: "tab",
              title: "Site",
              url: "https://example.test",
              driverGeneration: 1,
            }),
        });
        const pending = yield* grants.request({
          threadId,
          pid: 42,
          windowId: 7,
          origin: "https://example.test",
          windowTitle: "Browser",
        });
        if (pending.status !== "pending") return assert.fail("expected pending");
        yield* grants.answer(pending.claimId, true);
        const route = yield* threadFixture({
          grants: { ...grants, setDriverCapability: () => Effect.void },
        });
        // The arguments exactly as the proxy scoped them while it still held the claim.
        const scoped = {
          tab_id: "tab",
          target_id: "target-1",
          session: "goat-claim:" + pending.claimId,
          origin_scope: ["https://example.test"],
        };
        assert.deepEqual(yield* route.reserve("browser_click", scoped), {
          status: "admitted",
          reservationId: "reservation:test",
        });
        assert.deepEqual(
          yield* route.reserve("browser_click", { ...scoped, target_id: "target-other" }),
          { status: "refused", detail: "outside_manifest" },
        );
        yield* grants.revoke(threadId, "https://example.test");
        assert.deepEqual(yield* route.reserve("browser_click", scoped), {
          status: "refused",
          detail: "outside_manifest",
        });
        assert.deepEqual(yield* route.reserve("list_apps", {}), {
          status: "admitted",
          reservationId: "reservation:test",
        });
      }).pipe(Effect.scoped, Effect.provide(ServerSettings.layerTest({ enableCua: true }))),
  );

  it.effect("revoking a service claim makes the next proxied call refuse", () =>
    Effect.gen(function* () {
      const grants = yield* makeBrowserOriginGrants({
        environmentId: EnvironmentId.make("environment:test"),
        supported: () => true,
        publish: () => Effect.void,
        bind: () =>
          Effect.succeed({
            targetId: "target-1",
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
      const stream = yield* fixture({ ...grants, setDriverCapability: () => Effect.void }, true);
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
              targetId: "target-1",
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
        const service = { ...grants, setDriverCapability: () => Effect.void };
        const stream = yield* fixture(service, true);
        const initial = yield* stream.next;
        if (initial?.state !== "active") return assert.fail("expected active");
        assert.lengthOf(initial.browserClaims ?? [], 1);
        const reports: Array<unknown> = [];
        const h = yield* harness({
          autoAppListing: true,
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
          h.nextToDriver.pipe(Effect.map((message) => ({ kind: "sent", message }))),
          h.nextToProvider.pipe(Effect.map((message) => ({ kind: "refused", message }))),
        );
        assert.equal(sent.kind, "sent", JSON.stringify(sent.message));
        if (sent.kind !== "sent") return;
        const params = sent.message.params;
        if (typeof params !== "object" || params === null || !("arguments" in params))
          return assert.fail("expected call arguments");
        assert.deepEqual(params.arguments, {
          tab_id: "tab",
          target_id: "target-1",
          session: "goat-claim:browser-claim:1",
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
              resolve: () =>
                Effect.succeed({
                  environmentId: EnvironmentId.make("environment:test"),
                  capabilities: new Set<never>(),
                  issuedAt: 0,
                  requestNamespace: "test",
                  client: undefined,
                  thread: {
                    threadId,
                    providerSessionId: "session:test",
                    providerInstanceId: ProviderInstanceId.make("codex"),
                  },
                }),
            }),
          ),
        );
        const services = Context.make(McpSessionRegistry.McpSessionRegistry, registry).pipe(
          Context.add(BrowserOriginGrants, service),
          Context.add(
            ComputerUseLeases.ComputerUseLeases,
            yield* ComputerUseLeases.ComputerUseLeases.pipe(
              Effect.provide(Layer.mock(ComputerUseLeases.ComputerUseLeases)({ proxy: undefined })),
            ),
          ),
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
            targetId: "target-1",
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
        grants: { ...grants, setDriverCapability: () => Effect.void },
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
            targetId: "target-1",
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
            targetId: "target-1",
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
      const f = yield* fixture({ ...grants, setDriverCapability: () => Effect.void });
      const initial = yield* f.next;
      if (initial?.state !== "active") return assert.fail("expected active");
      assert.deepEqual(initial.browserClaims, [
        {
          claimId: request.claimId,
          claimGeneration: answer.agentResult.claim.claimGeneration,
          pid: 42,
          windowId: 7,
          targetId: "target-1",
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
});
