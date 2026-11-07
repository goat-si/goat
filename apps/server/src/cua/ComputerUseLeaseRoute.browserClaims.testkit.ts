import { assert } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
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
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSettings from "../serverSettings.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as LeaseRoute from "./ComputerUseLeaseRoute.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import { database } from "./ComputerUseLeases.projection.testkit.ts";
import * as ComputerUsePrimitiveChannel from "./ComputerUsePrimitiveChannel.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { BrowserOriginGrants } from "../preview/BrowserOriginGrantsLayer.ts";
import { makeTestBrowserOriginGrants } from "../preview/BrowserOriginGrants.testkit.ts";
const threadId = ThreadId.make("thread:bot");
const expiresAt = DateTime.makeUnsafe(10 * 60_000);

export const threadFixture = Effect.fn("LeaseRouteTest.threadFixture")(function* (
  options: {
    readonly livenessWindowMs?: number;
    readonly grants?: BrowserOriginGrants["Service"];
    readonly reservation?: ComputerUseLeases.ComputerUseLeases["Service"]["callReservation"];
    readonly leases?: ComputerUseLeases.ComputerUseLeases["Service"];
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
  const mockLeaseLayer = Layer.mock(ComputerUseLeases.ComputerUseLeases)({
    onAuthorityChange: () => () => {},
    releaseApps: (owner, id) => Effect.sync(() => released.push([owner, id])),
    streamOpened: () => Effect.void,
    proxy: undefined,
    callReservation:
      options.reservation ??
      (() => Effect.succeed({ status: "admitted", reservationId: "reservation:test" } as const)),
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
  const leaseLayer = options.leases
    ? Layer.succeed(ComputerUseLeases.ComputerUseLeases, options.leases)
    : mockLeaseLayer;
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
    postCall: (body: object) =>
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
              body: JSON.stringify(body),
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
    reserve: (name: string, args: unknown, authority?: "claimBind") =>
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
                ...(authority === undefined ? {} : { authority }),
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

export const admissionFixture = Effect.fn("LeaseRouteTest.admissionFixture")(function* () {
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
  return { leases, control };
});

export const claimedAdmissionFixture = Effect.fn("LeaseRouteTest.claimedAdmissionFixture")(
  function* () {
    const { leases, control } = yield* admissionFixture();
    let hosts: ReadonlyArray<string> = [];
    const grants = yield* makeTestBrowserOriginGrants({
      blockedHosts: Effect.sync(() => hosts),
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
    if (pending.status !== "pending") return yield* Effect.die("expected pending");
    yield* grants.answer(pending.claimId, true);
    const selected = yield* Deferred.make<void>();
    const route = yield* threadFixture({
      grants: {
        ...grants,
        setDriverCapability: () => Effect.void,
        admitClaimCall: (...args) =>
          grants
            .admitClaimCall(...args)
            .pipe(
              Effect.tap((result) =>
                result.status === "admit" && "claim" in result
                  ? Deferred.succeed(selected, undefined).pipe(Effect.asVoid)
                  : Effect.void,
              ),
            ),
      },
      leases,
    });
    const scoped = {
      tab_id: "tab",
      target_id: "target-1",
      session: "goat-claim:" + pending.claimId,
      origin_scope: ["https://example.test"],
    };
    return {
      grants,
      leases,
      control,
      route,
      scoped,
      selected,
      setBlocked: Effect.sync(() => {
        hosts = ["example.test"];
      }),
      block: Effect.suspend(() => {
        hosts = ["example.test"];
        return grants.blockedHostsChanged(hosts);
      }),
    };
  },
);
