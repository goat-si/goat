import { EnvironmentId } from "@goat/contracts";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as RpcHttp from "../rpc/http.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import * as RpcSession from "../rpc/session.ts";
import * as ConnectionDriver from "./driver.ts";
import * as ConnectionResolver from "./resolver.ts";
import { vi } from "vite-plus/test";
vi.mock("@goat/shared/goatConnect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));
import { expect, it } from "@effect/vitest";
import { RelayClientTracer } from "@goat/shared/relayTracing";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import { RelayConnectionTarget } from "./model.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import { TARGET, PREPARED_CONNECTION, awaitState, makeHarness } from "./supervisorTestSupport.ts";

it.effect("does not export the machine label on relay attempts", () =>
  Effect.gen(function* () {
    const spans: Tracer.NativeSpan[] = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const target = new RelayConnectionTarget({
      environmentId: TARGET.environmentId,
      label: "secret-machine-label",
    });
    const harness = yield* makeHarness({
      prepare: () => Effect.succeed({ ...PREPARED_CONNECTION, target }),
    });
    const supervisor = yield* EnvironmentSupervisor.make(
      { target, profile: Option.none(), enabled: true },
      { initiallyDesired: true },
    ).pipe(
      Effect.provide(harness.dependencies),
      Effect.provideService(RelayClientTracer, Option.some(tracer)),
    );
    yield* awaitState(supervisor.state, (state) => state.phase === "connected");
    const attempts = spans.filter((span) => span.name === "relay.connection.attempt");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.attributes.has("environment.label")).toBe(false);
  }),
);

it.effect("keeps a real driver's environment identifier out of every relay span", () =>
  Effect.gen(function* () {
    const sentinel = EnvironmentId.make("sentinel-secret-environment-id");
    const target = new RelayConnectionTarget({ environmentId: sentinel, label: "secret-machine" });
    const spans: Tracer.NativeSpan[] = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const localSpans: Tracer.NativeSpan[] = [];
    const localTracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        localSpans.push(span);
        return span;
      },
    });
    const prepared = { ...PREPARED_CONNECTION, environmentId: sentinel, target };
    const session = {
      client: {} as WsRpcProtocolClient,
      initialConfig: Effect.succeed({
        environment: { environmentId: sentinel, capabilities: {} },
      } as never),
      subscribeServerConfig: () => Stream.never,
      ready: Effect.void,
      probe: Effect.void,
      inboundFrames: Effect.succeed(0),
      closed: Effect.never,
    } satisfies RpcSession.RpcSession;
    const driver = yield* ConnectionDriver.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization)({
            rememberCheckedDescriptor: () => Effect.void,
          }),
          Layer.mock(ConnectionResolver.ConnectionResolver)({
            prepare: () => Effect.succeed(prepared),
          }),
          Layer.mock(RpcSession.RpcSessionFactory)({ connect: () => Effect.succeed(session) }),
          Layer.succeed(ClientCapabilities.PrimaryEnvironmentAuth, {
            bearerToken: Effect.succeedNone,
          }),
          RpcHttp.layerRemoteHttpClient(() => Promise.reject(new Error("unexpected request"))),
        ),
      ),
    );
    const harness = yield* makeHarness();
    const supervisor = yield* EnvironmentSupervisor.make(
      { target, profile: Option.none(), enabled: true },
      { initiallyDesired: true },
    ).pipe(
      Effect.provideService(ConnectionDriver.ConnectionDriver, driver),
      Effect.provide(harness.dependencies),
      Effect.provideService(RelayClientTracer, Option.some(tracer)),
      Effect.withTracer(localTracer),
    );
    yield* awaitState(supervisor.state, (state) => state.phase === "connected");
    expect(spans.some((span) => span.name === "relay.connection.attempt")).toBe(true);
    expect(spans.map((span) => JSON.stringify([...span.attributes])).join("\n")).not.toContain(
      sentinel,
    );
    expect(
      localSpans.some((span) => span.attributes.get("connection.environment.id") === sentinel),
    ).toBe(true);
  }),
);
