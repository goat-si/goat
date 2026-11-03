import {
  ORCHESTRATION_PROTOCOL_VERSION,
  EnvironmentId,
  type DesktopSshPreparationProgress,
  type ServerConfig,
} from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RpcHttp from "../rpc/http.ts";

import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import * as RpcSession from "../rpc/session.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import * as Driver from "./driver.ts";
import * as Resolver from "./resolver.ts";
import { hubProxyRefusal } from "./hubProxyHttp.ts";
import {
  ConnectionAttemptSuperseded,
  ConnectionTransientError,
  HubProxyConnectionTarget,
  SshConnectionTarget,
  type PreparedConnection,
} from "./model.ts";

const target = new SshConnectionTarget({
  environmentId: EnvironmentId.make("ssh-fixture"),
  label: "Fixture",
  connectionId: "ssh:fixture",
});
const entry: ConnectionCatalogEntry = { target, profile: Option.none(), enabled: true };
const prepared: PreparedConnection = {
  target,
  environmentId: target.environmentId,
  label: target.label,
  httpBaseUrl: "http://127.0.0.1:1234",
  socketUrl: "ws://127.0.0.1:1234/ws",
  httpAuthorization: null,
};
const client = {} as WsRpcProtocolClient;
const session: RpcSession.RpcSession = {
  client,
  initialConfig: Effect.never,
  subscribeServerConfig: (input) => client.subscribeServerConfig(input),
  ready: Effect.void,
  probe: Effect.void,
  inboundFrames: Effect.succeed(0),
  closed: Effect.never,
};

function driverWith(prepare: Resolver.ConnectionResolver["Service"]["prepare"]) {
  return Driver.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(Resolver.ConnectionResolver)({ prepare }),
        Layer.mock(RpcSession.RpcSessionFactory)({ connect: () => Effect.succeed(session) }),
        RpcHttp.layerRemoteHttpClient(() => Promise.reject(new Error("No HTTP request expected."))),
      ),
    ),
  );
}

describe("SSH driver routing", () => {
  it.effect("keeps retrying an unreachable direct route and names the hub's refusal", () =>
    Effect.gen(function* () {
      const refusal = hubProxyRefusal({ requiredScope: "hub:proxy" });
      const error = yield* Driver.connectOverRoutes(
        {
          ...entry,
          alternateRoutes: [
            {
              target: new HubProxyConnectionTarget({
                environmentId: target.environmentId,
                label: target.label,
                connectionId: "hub:fixture",
              }),
              profile: Option.none(),
            },
          ],
        },
        () => Effect.succeed("unchecked"),
        (route) =>
          route.target._tag === "HubProxyConnectionTarget"
            ? Effect.fail(refusal)
            : Effect.fail(
                new ConnectionTransientError({ reason: "endpoint-unavailable", detail: "Offline" }),
              ),
      ).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "ConnectionTransientError",
        reason: "endpoint-unavailable",
      });
      expect(error.detail).toContain(refusal.detail);
    }),
  );
  it.effect("stops a neutral attempt before trying a fallback route", () =>
    Effect.gen(function* () {
      const routes: string[] = [];
      const error = new ConnectionAttemptSuperseded({
        reason: "superseded",
        detail: "Newer disconnect.",
      });
      const result = yield* Driver.connectOverRoutes(
        {
          ...entry,
          alternateRoutes: [
            {
              target: new SshConnectionTarget({ ...target, connectionId: "ssh:fallback" }),
              profile: Option.none(),
            },
          ],
        },
        () => Effect.succeed("unchecked"),
        (route) => Effect.sync(() => routes.push(route.target._tag)).pipe(Effect.andThen(error)),
      ).pipe(Effect.flip);
      expect(result).toBe(error);
      expect(routes).toEqual(["SshConnectionTarget"]);
    }),
  );

  it.effect(
    "fences every answered and phase report to the actual route and forwards attempt context",
    () =>
      Effect.gen(function* () {
        const reports: Driver.ConnectionDriverProgress[] = [];
        const phase: DesktopSshPreparationProgress = {
          operationId: "flight",
          phase: "uploading",
          hostAnswered: true,
          remainingMs: 900_000,
        };
        const driver = yield* driverWith((_entry, answered, options) =>
          Effect.gen(function* () {
            expect(options?.attemptContext).toEqual({
              supervisorId: "owner",
              attemptId: 7,
              routeId: "ssh:fixture",
            });
            yield* answered!;
            yield* options!.onPreparationProgress!(phase);
            return prepared;
          }),
        );
        yield* driver.connect(
          entry,
          (progress) =>
            Effect.sync(() => {
              reports.push(progress);
            }),
          { supervisorId: "owner", attemptId: 7 },
        );
        expect(reports.filter((report) => report.stage === "preparing")).toEqual([
          { stage: "preparing", routeId: "ssh:fixture" },
          { stage: "preparing", routeId: "ssh:fixture", hostAnswered: true },
          { stage: "preparing", routeId: "ssh:fixture", sshPreparation: phase },
        ]);
        expect(
          reports.filter((report) => report.stage !== "preparing").map((report) => report.stage),
        ).toEqual(["opening", "synchronizing"]);
      }),
  );

  it.effect(
    "leaves a better SSH route unchecked and starts zero preparations during preflight",
    () =>
      Effect.gen(function* () {
        let ensures = 0;
        const driver = yield* driverWith(() =>
          Effect.sync(() => {
            ensures++;
            return prepared;
          }),
        );
        expect(yield* driver.checkRoute(entry, entry)).toBe("unchecked");
        expect(yield* driver.preflight(entry, entry)).toBe(false);
        expect(ensures).toBe(0);
      }),
  );
});

describe("live host checks", () => {
  it.effect.each(["matching", "different", "unreachable"] as const)(
    "checks the session origin afresh without credentials (%s)",
    (reply) =>
      Effect.gen(function* () {
        const calls: { readonly url: string; readonly init: RequestInit }[] = [];
        const driver = yield* Driver.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(Resolver.ConnectionResolver)({}),
              Layer.mock(RpcSession.RpcSessionFactory)({}),
              RpcHttp.layerRemoteHttpClient((url, init) => {
                calls.push({ url: String(url), init: init ?? {} });
                return Promise.resolve(
                  reply === "unreachable"
                    ? new Response(null, { status: 503 })
                    : Response.json({
                        environmentId:
                          reply === "matching" ? target.environmentId : "another-environment",
                        label: "Fixture",
                        platform: { os: "linux", arch: "x64" },
                        serverVersion: "0.0.0-test",
                        orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
                        capabilities: {},
                      }),
                );
              }),
            ),
          ),
        );
        expect(
          yield* driver.checkHost({
            ...prepared,
            httpAuthorization: { _tag: "Bearer", token: "fixture-token" },
          }),
        ).toBe(reply === "matching" ? "answered" : "silent");
        expect(calls).toHaveLength(1);
        const request = calls[0]!;
        expect(request.url).toBe("http://127.0.0.1:1234/.well-known/goat/environment");
        expect(request.init.cache).toBe("no-store");
        expect(request.init.credentials).toBe("omit");
        const headers = new Headers(request.init.headers);
        expect(headers.has("authorization")).toBe(false);
        expect(headers.has("dpop")).toBe(false);
        expect(headers.has("cookie")).toBe(false);
      }),
  );
});

it.effect("identity mismatch -> no Authorization header sent, kept", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const requests: RequestInit[] = [];
      const bearer = {
        ...prepared,
        httpAuthorization: { _tag: "Bearer" as const, token: "fixture-token" },
      };
      const driver = yield* Driver.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Resolver.ConnectionResolver)({ prepare: () => Effect.succeed(bearer) }),
            Layer.mock(RpcSession.RpcSessionFactory)({ connect: () => Effect.succeed(session) }),
            RpcHttp.layerRemoteHttpClient((_url, init) => {
              requests.push(init ?? {});
              return Promise.resolve(
                Response.json({
                  environmentId: "another-environment",
                  label: "Other",
                  platform: { os: "linux", arch: "x64" },
                  serverVersion: "0.0.0-test",
                  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
                  capabilities: {},
                }),
              );
            }),
          ),
        ),
      );
      const lease = yield* driver.connect(entry, () => Effect.void);
      expect((yield* Effect.exit(lease.openProbeSocket))._tag).toBe("Failure");
      expect(requests).toHaveLength(1);
      expect(new Headers(requests[0]?.headers).has("authorization")).toBe(false);
    }),
  ),
);

it.effect("SSH lease opens a probe socket without re-preparing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let preparations = 0;
      const urls: string[] = [];
      const bearer = {
        ...prepared,
        socketUrl: `${prepared.socketUrl}?wsTicket=old`,
        httpAuthorization: { _tag: "Bearer" as const, token: "fixture-token" },
      };
      const config = { environment: { capabilities: { connectionProbe: true } } } as ServerConfig;
      const driver = yield* Driver.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Resolver.ConnectionResolver)({
              prepare: () =>
                Effect.sync(() => {
                  preparations++;
                  return bearer;
                }),
            }),
            Layer.mock(RpcSession.RpcSessionFactory)({
              connect: () => Effect.succeed({ ...session, initialConfig: Effect.succeed(config) }),
              openProbe: (fresh) =>
                Effect.sync(() => {
                  urls.push(fresh.socketUrl);
                  return { probe: Effect.void, drainIo: Effect.void };
                }),
            }),
            RpcHttp.layerRemoteHttpClient((url) => {
              const address = String(url);
              return Promise.resolve(
                address.includes("websocket-ticket")
                  ? Response.json({ ticket: "fresh-ticket", expiresAt: "2026-10-19T01:00:00.000Z" })
                  : Response.json({
                      environmentId: target.environmentId,
                      label: "Fixture",
                      platform: { os: "linux", arch: "x64" },
                      serverVersion: "0.0.0-test",
                      orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
                      capabilities: {},
                    }),
              );
            }),
          ),
        ),
      );
      const lease = yield* driver.connect(entry, () => Effect.void);
      const probe = yield* lease.openProbeSocket;
      yield* probe.probe;
      expect(preparations).toBe(1);
      expect(urls).toEqual([`${prepared.socketUrl}?wsTicket=fresh-ticket`]);
    }),
  ),
);
