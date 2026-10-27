import {
  ORCHESTRATION_PROTOCOL_VERSION,
  EnvironmentId,
  type DesktopSshPreparationProgress,
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
import {
  ConnectionAttemptSuperseded,
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
