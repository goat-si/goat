import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ComputerUsePauseReason,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest } from "effect/http";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSettings from "../serverSettings.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { leaseUpdates } from "./ComputerUseLeaseRoute.ts";
import * as LeaseRoute from "./ComputerUseLeaseRoute.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import type { ComputerUseControlState } from "./ComputerUseControl.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { makeTestBrowserOriginGrants as makeBrowserOriginGrants } from "../preview/BrowserOriginGrants.testkit.ts";
import { BrowserOriginGrants } from "../preview/BrowserOriginGrantsLayer.ts";
import * as Grants from "../preview/BrowserOriginGrantsLayer.ts";
import { BrowserClaimManifest } from "../preview/BrowserClaimManifest.ts";
import { active, harness, call } from "./ComputerUseLeaseProxy.testkit.ts";
import { database } from "./ComputerUseLeases.projection.testkit.ts";
import { threadFixture } from "./ComputerUseLeaseRoute.browserClaims.testkit.ts";

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

describe("computer use lease route", () => {
  it.effect.each(["browser_click", "get_browser_state"] as const)(
    "a reply from a newly blocked host ends the claim and withholds $0 safely",
    (tool) =>
      Effect.gen(function* () {
        let hosts: ReadonlyArray<string> = [];
        const grants = yield* makeBrowserOriginGrants({
          environmentId: EnvironmentId.make("environment:test"),
          supported: () => true,
          blockedHosts: () => hosts,
          publish: () => Effect.void,
          bind: (input) =>
            Effect.succeed({
              targetId: "target-" + input.windowId,
              tabId: "tab-" + input.windowId,
              title: "Site",
              url: input.origin,
              driverGeneration: 1,
            }),
        });
        const ids: string[] = [];
        for (const [windowId, origin] of [
          [7, "https://example.test"],
          [8, "https://other.test"],
        ] as const) {
          const pending = yield* grants.request({
            threadId,
            pid: 42,
            windowId,
            origin,
            windowTitle: "Browser",
          });
          if (pending.status !== "pending") return assert.fail("expected pending");
          ids.push(pending.claimId);
          yield* grants.answer(pending.claimId, true);
        }
        const route = yield* threadFixture({
          grants: { ...grants, setDriverCapability: () => Effect.void },
        });
        const handler = yield* HttpRouter.toHttpEffect(LeaseRoute.reportLayer);
        const h = yield* harness({
          autoAppListing: true,
          judgeBrowserClaimReply: (report) =>
            Effect.scoped(
              handler.pipe(
                Effect.provideService(
                  HttpServerRequest.HttpServerRequest,
                  HttpServerRequest.fromWeb(
                    new Request("http://goat.test/api/computer-use/lease", {
                      method: "POST",
                      headers: { authorization: route.credential.config.authorizationHeader },
                      body: JSON.stringify(report),
                    }),
                  ),
                ),
                Effect.provideContext(route.context),
                Effect.map((response) => response.status === 204),
                Effect.orElseSucceed(() => false),
              ),
            ),
        });
        yield* h.push({ ...active(), browserClaims: yield* grants.claimsFor(threadId) });
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
        yield* h.send(call(3, tool, { tab_id: "tab-7" }));
        yield* h.nextToDriver;
        hosts = ["other.test"];
        yield* h.reply(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            result: { structuredContent: { tab_id: "tab-7", url: "https://other.test/secret" } },
          }),
        );
        const reply = yield* h.nextToProvider;
        assert.notInclude(JSON.stringify(reply), "secret");
        assert.equal(yield* grants.endReason(threadId, ids[0]!), "origin_changed");
        const released = h.reservations.filter((item) => item.action === "release");
        assert.lengthOf(released, 1);
        assert.equal(
          released[0]?.action === "release" && released[0].notSent === true,
          tool === "get_browser_state",
        );
        if (tool === "browser_click")
          assert.deepInclude((reply.result as { structuredContent: object }).structuredContent, {
            effect: "unverifiable",
          });
      }).pipe(Effect.scoped),
  );
  it.effect("browserClaimReply ends the claim when a URL is blocked and answers 409", () =>
    Effect.gen(function* () {
      let hosts: ReadonlyArray<string> = [];
      const grants = yield* makeBrowserOriginGrants({
        environmentId: EnvironmentId.make("environment:test"),
        supported: () => true,
        blockedHosts: () => hosts,
        publish: () => Effect.void,
        bind: () =>
          Effect.succeed({
            targetId: "target",
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
      const route = yield* threadFixture({
        grants: { ...grants, setDriverCapability: () => Effect.void },
      });
      hosts = ["example.test"];
      const handler = yield* HttpRouter.toHttpEffect(LeaseRoute.reportLayer);
      const response = yield* handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request("http://goat.test/api/computer-use/lease", {
              method: "POST",
              headers: { authorization: route.credential.config.authorizationHeader },
              body: JSON.stringify({
                browserClaimReply: {
                  claimId: request.claimId,
                  claimGeneration: answer.agentResult.claim.claimGeneration,
                  urls: ["https://example.test/private"],
                },
              }),
            }),
          ),
        ),
        Effect.provideContext(route.context),
      );
      assert.equal(response.status, 409);
      assert.equal(yield* grants.endReason(threadId, request.claimId), "origin_changed");
    }).pipe(Effect.scoped),
  );
  it.effect("a claimed-tab call to a newly blocked host is refused at validation", () =>
    Effect.gen(function* () {
      let hosts: ReadonlyArray<string> = [];
      const grants = yield* makeBrowserOriginGrants({
        environmentId: EnvironmentId.make("environment:test"),
        supported: () => true,
        blockedHosts: () => hosts,
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
      hosts = ["other.test"];
      assert.deepEqual(
        yield* route.reserve("browser_navigate", { ...scoped, url: "https://other.test/page" }),
        { status: "refused", detail: "outside_manifest" },
      );
      assert.deepEqual(yield* route.reserve("browser_click", scoped), {
        status: "admitted",
        reservationId: "reservation:test",
      });
      hosts = ["example.test"];
      assert.deepEqual(
        yield* route.postCall({
          action: "validate",
          controlId: "control:test",
          connectionId: "driver:1",
          reservationId: "reservation:test",
        }),
        { status: "refused", detail: "outside_manifest" },
      );
    }).pipe(Effect.scoped, Effect.provide(ServerSettings.layerTest({ enableCua: true }))),
  );
  it.effect("validation refuses a claim revoked while the call waited for admission", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        ComputerUseLeases.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              database,
              NodeServices.layer,
              ServerSettings.layerTest({ enableCua: true, cuaStrictInputGuards: false }),
            ),
          ),
        ),
      );
      yield* runMigrations().pipe(Effect.provideContext(context));
      const sql = Context.get(context, SqlClient.SqlClient);
      yield* sql`INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
        VALUES (${threadId}, 'project', 'thread', 'codex', 'full-access', 'default', '2026-01-01', '2026-01-01', '{}')`;
      const leases = Context.get(context, ComputerUseLeases.ComputerUseLeases);
      const control = Option.getOrThrow(yield* leases.everyAppControl(threadId, false));
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
        leases,
      });
      const scoped = {
        tab_id: "tab",
        target_id: "target-1",
        session: "goat-claim:" + pending.claimId,
        origin_scope: ["https://example.test"],
      };
      const reserved = yield* route.postCall({
        action: "reserve",
        controlId: control.controlId,
        connectionId: "driver:1",
        callId: "one",
        name: "browser_click",
        args: scoped,
        interruptions: 0,
        idleEpoch: 0,
      });
      if (
        typeof reserved !== "object" ||
        reserved === null ||
        !("reservationId" in reserved) ||
        typeof reserved.reservationId !== "string"
      )
        return assert.fail("expected reservation");
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* leases
        .serializeAdmission(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const validation = yield* route
        .postCall({
          action: "validate",
          controlId: control.controlId,
          connectionId: "driver:1",
          reservationId: reserved.reservationId,
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* grants.revoke(threadId, "https://example.test");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      assert.deepEqual(yield* Fiber.join(validation), {
        status: "refused",
        detail: "outside_manifest",
      });
    }).pipe(Effect.scoped),
  );
  it.effect(
    "thread capability reports cannot raise support and end only their thread's claims",
    () =>
      Effect.gen(function* () {
        const grantContext = yield* Layer.build(
          Grants.layer.pipe(
            Layer.provide(ServerSettings.layerTest()),
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
        const other = ThreadId.make("thread:other");
        assert.equal(
          (yield* grants.request({ ...input, threadId: other, windowId: 8 })).status,
          "pending",
        );
        assert.equal((yield* report(false)).status, 204);
        // The server's own probe still vouches for the driver; only the reporter's requests end.
        assert.deepEqual(
          (yield* grants.listAll()).pending.map((entry) => entry.threadId),
          [other],
        );
        assert.equal((yield* grants.request({ ...input, windowId: 9 })).status, "pending");
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
          judgeBrowserClaimReply: (report) =>
            Effect.sync(() => {
              reports.push(report);
              return false;
            }),
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
            typeof report === "object" && report !== null && "browserClaimReply" in report,
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
        assert.equal(status, 409);
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
