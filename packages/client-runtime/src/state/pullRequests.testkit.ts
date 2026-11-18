import { EnvironmentId, WS_METHODS } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createPullRequestEnvironmentAtoms } from "./pullRequests.ts";
import * as PullRequestDiffLoader from "./pullRequestDiffHttp.ts";

export const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

export function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client: {
      ...client,
      [WS_METHODS.pullRequestsInvalidate]:
        client[WS_METHODS.pullRequestsInvalidate] ?? (() => Effect.void),
    },
    initialConfig: client[WS_METHODS.serverGetConfig]?.({}).pipe(Effect.orDie) ?? Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input ?? {}),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
}

export const makeTestRuntime = Effect.fn("makeTestRuntime")(function* (
  client: WsRpcProtocolClient,
  localClient?: WsRpcProtocolClient,
  localOrigin = false,
) {
  const originTarget = localOrigin
    ? new PrimaryConnectionTarget({
        ...TARGET,
        httpBaseUrl: "http://localhost:3774",
        wsBaseUrl: "ws://localhost:3774",
      })
    : TARGET;
  const connectionState: SupervisorConnectionState = {
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    network: "online",
    phase: "connected",
    attempt: 1,
    generation: 1,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: originTarget,
    state: yield* SubscriptionRef.make(connectionState),
    session: yield* SubscriptionRef.make(Option.some(session(client))),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const localTarget = new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make("local-environment"),
    label: "Local environment",
    httpBaseUrl: "http://localhost:3773",
    wsBaseUrl: "ws://localhost:3773",
  });
  const localSupervisor = {
    ...supervisor,
    target: localTarget,
    session: yield* SubscriptionRef.make(Option.some(session(localClient ?? client))),
  };
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map([
        [
          originTarget.environmentId,
          { target: originTarget, profile: Option.none(), enabled: true },
        ],
        ...(localClient === undefined
          ? []
          : [
              [
                localTarget.environmentId,
                { target: localTarget, profile: Option.none(), enabled: true },
              ] as const,
            ]),
      ]),
    ),
    run: (environmentId, effect) =>
      Effect.provideService(
        effect,
        EnvironmentSupervisor.EnvironmentSupervisor,
        environmentId === localTarget.environmentId ? localSupervisor : supervisor,
      ),
    runStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    followStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
      Layer.succeed(
        PullRequestDiffLoader.PullRequestDiffLoader,
        PullRequestDiffLoader.PullRequestDiffLoader.of({ load: () => Effect.die("unused") }),
      ),
    ),
  );
  const atoms = createPullRequestEnvironmentAtoms(runtime);
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  return { runtime, atoms, registry, environmentRegistry, supervisor, localSupervisor };
});
