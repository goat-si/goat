import { EnvironmentId } from "@goat/contracts";
import { GOAT_CONNECT_COMING_SOON } from "@goat/shared/goatConnect";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

import {
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
} from "./catalog.ts";
import * as Driver from "./driver.ts";
import { BearerConnectionTarget, RelayConnectionTarget, type PreparedConnection } from "./model.ts";
import * as Resolver from "./resolver.ts";
import { connectionRoutes, isConnectionRouteEnabled, usableRoutes } from "./routes.ts";
import * as RpcHttp from "../rpc/http.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";

const environmentId = EnvironmentId.make("environment-1");
const relay: ConnectionRoute = {
  target: new RelayConnectionTarget({ environmentId, label: "Desk" }),
  profile: Option.none(),
};
function direct(connectionId: string, authorization?: "t3-connect"): ConnectionRoute {
  return {
    target: new BearerConnectionTarget({ environmentId, label: "Desk", connectionId }),
    profile: Option.some(
      new BearerConnectionProfile({
        environmentId,
        label: "Desk",
        connectionId,
        httpBaseUrl: "https://desk.tail1234.ts.net/",
        wsBaseUrl: "wss://desk.tail1234.ts.net/",
        network: "tailscale",
        ...(authorization === undefined ? {} : { authorization, learned: true }),
      }),
    ),
  };
}
const learned = direct("learned:t3", "t3-connect");
const tailnet = direct("paired-tailnet");
const entry = (
  route: ConnectionRoute,
  alternateRoutes: ReadonlyArray<ConnectionRoute> = [],
): ConnectionCatalogEntry => ({
  ...route,
  enabled: true,
  alternateRoutes,
});

function harness() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const prepare = vi.fn((saved: ConnectionCatalogEntry) =>
    Effect.succeed({
      environmentId,
      label: "Desk",
      target: saved.target,
      httpBaseUrl: "https://desk.tail1234.ts.net/",
      socketUrl: "wss://desk.tail1234.ts.net/ws",
      httpAuthorization: { _tag: "Bearer" as const, token: "paired-token" },
    }),
  );
  const connect = vi.fn((_prepared: PreparedConnection) =>
    Effect.succeed({
      client: {} as WsRpcProtocolClient,
      initialConfig: Effect.die("unused"),
      subscribeServerConfig: () => {
        throw new Error("unused");
      },
      ready: Effect.void,
      probe: Effect.void,
      inboundFrames: Effect.succeed(0),
      closed: Effect.never,
    }),
  );
  const make = Driver.make.pipe(
    Effect.provideService(Resolver.ConnectionResolver, {
      prepare,
      prepareForUpdate: () => Effect.die("unused"),
    }),
    Effect.provideService(RpcSession.RpcSessionFactory, { connect }),
    Effect.provide(RpcHttp.layerRemoteHttpClient(fetch)),
  );
  return { fetch, prepare, connect, make };
}

describe("connection driver with Connect disabled", () => {
  it.effect.each([relay, learned])(
    "blocks a Connect-only saved route before probes, resolver or sockets (%s)",
    (route) =>
      Effect.gen(function* () {
        const saved = entry(route);
        const before = connectionRoutes(saved);
        const h = harness();
        const driver = yield* h.make;
        expect(isConnectionRouteEnabled(route)).toBe(false);
        expect(usableRoutes(saved)).toEqual([]);
        expect(yield* driver.checkRoute(saved, route)).toBe("silent");
        expect(yield* driver.preflight(saved, route)).toBe(false);
        const failure = yield* driver.connect(saved, () => Effect.void).pipe(Effect.flip);
        expect(failure).toMatchObject({
          _tag: "ConnectionBlockedError",
          reason: "configuration",
          detail: `${GOAT_CONNECT_COMING_SOON.title} is coming soon. ${GOAT_CONNECT_COMING_SOON.description}`,
        });
        expect(connectionRoutes(saved)).toEqual(before);
        expect(saved.enabled).toBe(true);
        expect(h.fetch).not.toHaveBeenCalled();
        expect(h.prepare).not.toHaveBeenCalled();
        expect(h.connect).not.toHaveBeenCalled();
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    [relay, [learned, tailnet]],
    [tailnet, [relay, learned]],
  ] as const)(
    "connects a mixed environment through its paired direct route (%s)",
    ([primary, alternates]) =>
      Effect.gen(function* () {
        const saved = entry(primary, alternates);
        const before = connectionRoutes(saved);
        const h = harness();
        const driver = yield* h.make;
        expect(usableRoutes(saved)).toEqual([tailnet]);
        const result = yield* driver.connect(saved, () => Effect.void);
        expect(result.prepared.target).toEqual(tailnet.target);
        expect(h.prepare).toHaveBeenCalledTimes(1);
        expect(h.prepare.mock.calls[0]?.[0].target).toEqual(tailnet.target);
        expect(h.connect).toHaveBeenCalledTimes(1);
        expect(h.fetch).not.toHaveBeenCalled();
        expect(connectionRoutes(saved)).toEqual(before);
      }).pipe(Effect.scoped),
  );

  it.effect("preserves the transient fallback for unrelated unusable routes", () =>
    Effect.gen(function* () {
      const target = new BearerConnectionTarget({
        environmentId,
        label: "Desk",
        connectionId: "learned:environment-1:http://public.test@paired",
      });
      const saved = entry({
        target,
        profile: Option.some(
          new BearerConnectionProfile({
            environmentId,
            label: target.label,
            connectionId: target.connectionId,
            httpBaseUrl: "http://public.test/",
            wsBaseUrl: "ws://public.test/",
            learned: true,
          }),
        ),
      });
      expect(usableRoutes(saved)).toEqual([]);
      const h = harness();
      const driver = yield* h.make;
      const failure = yield* driver.connect(saved, () => Effect.void).pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "ConnectionTransientError",
        reason: "endpoint-unavailable",
      });
      expect(h.prepare).not.toHaveBeenCalled();
      expect(h.fetch).not.toHaveBeenCalled();
    }).pipe(Effect.scoped),
  );
});
