import { EnvironmentId } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as ConnectionDriver from "../connection/driver.ts";
import { BearerConnectionTarget } from "../connection/model.ts";
import * as ConnectionResolver from "../connection/resolver.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as RpcSession from "../rpc/session.ts";
import {
  DESCRIPTOR,
  ENDPOINT,
  ENVIRONMENT_ID,
  makeHarness,
  websocketTicket,
} from "./remoteAuthorization.testkit.ts";
import * as RemoteAuthorization from "./service.ts";

const preparedAt = (httpBaseUrl: string) => ({
  httpBaseUrl,
  environmentId: ENVIRONMENT_ID,
  label: DESCRIPTOR.label,
  socketUrl: httpBaseUrl.replace(/^http/, "ws"),
  httpAuthorization: null,
  target: new BearerConnectionTarget({
    environmentId: ENVIRONMENT_ID,
    label: DESCRIPTOR.label,
    connectionId: "direct-1",
  }),
});

const makeCheck = Effect.fn("test.makeDescriptorCheck")(function* (
  httpBaseUrl = ENDPOINT.httpBaseUrl,
) {
  const prepared = preparedAt(httpBaseUrl);
  let environmentId = ENVIRONMENT_ID;
  const harness = yield* makeHarness({
    responses: Array.from(
      { length: 24 },
      () => (init: RequestInit) =>
        new Headers(init.headers).has("Authorization")
          ? websocketTicket("authorized")
          : Response.json({ ...DESCRIPTOR, environmentId }),
    ),
  });
  const layer = ConnectionDriver.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        harness.layer,
        Layer.mock(ConnectionResolver.ConnectionResolver)({}),
        Layer.mock(RpcSession.RpcSessionFactory)({}),
        Layer.mock(ClientCapabilities.PrimaryEnvironmentAuth)({}),
      ),
    ),
  );
  return yield* Effect.gen(function* () {
    const driver = yield* ConnectionDriver.ConnectionDriver;
    const remote = yield* RemoteAuthorization.RemoteEnvironmentAuthorization;
    return {
      check: driver.checkHost(prepared),
      authorize: remote.authorizeBearer({
        expectedEnvironmentId: ENVIRONMENT_ID,
        httpBaseUrl,
        wsBaseUrl: prepared.socketUrl,
        connectionMethod: "direct",
        bearerToken: "test-bearer",
      }),
      descriptorReads: () =>
        harness.fetch.calls.filter(([url]) => String(url).includes("/.well-known/")),
      setEnvironment: (value: EnvironmentId) => {
        environmentId = value;
      },
    };
  }).pipe(Effect.provide(layer));
});

it.effect("one fresh HTTPS host check can satisfy one direct authorization", () =>
  Effect.gen(function* () {
    const h = yield* makeCheck();
    expect(yield* h.check).toBe("answered");
    yield* h.authorize;
    expect(h.descriptorReads()).toHaveLength(1);
    yield* h.authorize;
    expect(h.descriptorReads()).toHaveLength(2);
  }),
);

it.effect("plain LAN checks read the host even when the bearer cache is warm", () =>
  Effect.gen(function* () {
    const h = yield* makeCheck("http://192.168.1.2:3773");
    yield* h.authorize;
    h.setEnvironment(EnvironmentId.make("other"));
    expect(yield* h.check).toBe("silent");
    expect(h.descriptorReads()).toHaveLength(2);
    const check = h.descriptorReads()[1]?.[1];
    expect(check?.credentials).toBe("omit");
    expect(new Headers(check?.headers).has("Authorization")).toBe(false);
    yield* TestClock.adjust("11 seconds");
    h.setEnvironment(ENVIRONMENT_ID);
    yield* h.authorize;
    expect(h.descriptorReads()).toHaveLength(3);
  }),
);

it.effect("expired or mismatching checked descriptors require a fresh direct read", () =>
  Effect.gen(function* () {
    const h = yield* makeCheck();
    expect(yield* h.check).toBe("answered");
    yield* TestClock.adjust("6 seconds");
    yield* h.authorize;
    expect(h.descriptorReads()).toHaveLength(2);
    yield* TestClock.adjust("11 seconds");
    h.setEnvironment(EnvironmentId.make("other"));
    expect(yield* h.check).toBe("silent");
    h.setEnvironment(ENVIRONMENT_ID);
    yield* h.authorize;
    expect(h.descriptorReads()).toHaveLength(4);
  }),
);
