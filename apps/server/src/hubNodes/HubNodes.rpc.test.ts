import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type HubNode,
  type HubNodesSnapshot,
  WS_METHODS,
  WsHubNodesRpcGroup,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import {
  RpcInstrumentation,
  rpcInstrumentationLayer as instrumentationLayer,
} from "../observability/RpcInstrumentation.ts";
import { makeHubNodesHandlers } from "./HubNodes.rpc.ts";
import * as HubNodes from "./HubNodes.ts";

const group = WsHubNodesRpcGroup.middleware(RpcInstrumentation);

const input = {
  kind: "ssh" as const,
  alias: "build-host",
  hostname: null,
  username: null,
  port: null,
};

it.effect("two RPC clients share hub changes while a read-only session cannot add", () =>
  Effect.gen(function* () {
    const environmentId = EnvironmentId.make("hub-test");
    const remoteId = EnvironmentId.make("remote-test");
    let current: HubNodesSnapshot = { hubEnvironmentId: environmentId, nodes: [], notices: [] };
    const signals = yield* PubSub.unbounded<HubNodesSnapshot>();
    const snapshot = Effect.sync(() => current);
    const hub = Layer.mock(HubNodes.HubNodes)({
      snapshot,
      changes: Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(signals);
          return Stream.concat(Stream.fromEffect(snapshot), Stream.fromSubscription(subscription));
        }),
      ),
      add: (request, options) =>
        Effect.gen(function* () {
          yield* options.beforeSave;
          expect(request).toEqual(input);
          expect(options.addedBy.kind).toBe("user");
          expect(options.addedBy.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
          const node: HubNode = {
            nodeId: remoteId,
            environmentId: remoteId,
            label: "build-host",
            kind: "ssh",
            status: "online",
            lastSeenAt: null,
            addedBy: options.addedBy,
            routes: [
              {
                routeId: "ssh:build-host",
                source: "registered",
                target: input,
                status: "online",
                checkedAt: null,
                lastSeenAt: null,
                lastError: null,
              },
            ],
          };
          current = { ...current, nodes: [node] };
          yield* PubSub.publish(signals, current);
          return { created: true, node };
        }),
    });
    const handlers = WsHubNodesRpcGroup.middleware(RpcInstrumentation)
      .toLayer(makeHubNodesHandlers)
      .pipe(Layer.provide(hub));
    const readerLayers = Layer.mergeAll(
      handlers,
      instrumentationLayer,
      RpcAuthorization.layer(["orchestration:read"]),
    );
    const writerLayers = Layer.mergeAll(
      handlers,
      instrumentationLayer,
      RpcAuthorization.layer(["orchestration:read", "settings:write"]),
    );
    expect(RpcAuthorization.requiredScopeForRpcMethod(WS_METHODS.hubNodesAdd)).toBe(
      "settings:write",
    );
    expect(
      yield* RpcAuthorization.authorizeRpcCall(
        ["orchestration:read"],
        WS_METHODS.hubNodesAdd,
        input,
      ).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: "settings:write" });
    const clientA = yield* RpcTest.makeClient(group).pipe(Effect.provide(readerLayers));
    const clientB = yield* RpcTest.makeClient(group).pipe(Effect.provide(writerLayers));
    expect(yield* clientA[WS_METHODS.hubNodesList]({})).toEqual(current);
    expect(yield* clientA[WS_METHODS.hubNodesAdd](input).pipe(Effect.flip)).toMatchObject({
      _tag: "EnvironmentAuthorizationError",
      requiredPermission: "settings:write",
    });
    expect(current.nodes).toEqual([]);
    const initial = yield* Deferred.make<void>();
    const received = yield* Deferred.make<HubNodesSnapshot>();
    yield* clientA[WS_METHODS.hubNodesSubscribe]({}).pipe(
      Stream.runForEach((value) =>
        value.nodes.length === 0
          ? Deferred.succeed(initial, undefined).pipe(Effect.asVoid)
          : Deferred.succeed(received, value).pipe(Effect.asVoid),
      ),
      Effect.forkScoped,
    );
    yield* Deferred.await(initial);
    const added = yield* clientB[WS_METHODS.hubNodesAdd](input);
    expect((yield* Deferred.await(received)).nodes).toEqual([added.node]);
    expect((yield* clientA[WS_METHODS.hubNodesList]({})).nodes).toEqual([added.node]);
  }).pipe(Effect.scoped),
);
