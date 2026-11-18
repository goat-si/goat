import { EnvironmentId, WS_METHODS, type ServerConfig } from "@goat/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createServerEnvironmentAtoms } from "./server.ts";

const CONFIG = {
  availableEditors: [],
  issues: [],
  keybindings: {},
  keybindingsConfigPath: null,
  observability: null,
  providers: [],
  settings: {},
  environment: { capabilities: {} },
} as unknown as ServerConfig;
const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.succeed(CONFIG),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input ?? {}),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
}

describe("resource telemetry history", () => {
  it.effect.each([
    ["resourceTelemetryHistory", WS_METHODS.serverGetResourceTelemetryHistory],
    ["processResourceHistory", WS_METHODS.serverGetProcessResourceHistory],
  ] as const)(
    "%s refreshes an initially empty history while mounted and stops after unmount",
    ([atomKey, method]) =>
      Effect.gen(function* () {
        vi.useFakeTimers();
        try {
          yield* Effect.scoped(
            Effect.gen(function* () {
              let reads = 0;
              const client = {
                [method]: () =>
                  Effect.sync(() => ({
                    retainedSampleCount: reads++,
                  })),
              } as unknown as WsRpcProtocolClient;
              const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
                target: TARGET,
                state: yield* SubscriptionRef.make<SupervisorConnectionState>({
                  ...AVAILABLE_CONNECTION_STATE,
                  phase: "connected",
                }),
                session: yield* SubscriptionRef.make(Option.some(session(client))),
                prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
                connect: Effect.void,
                disconnect: Effect.void,
                retryNow: Effect.void,
              });
              const environments = EnvironmentRegistry.EnvironmentRegistry.of({
                run: (_id, effect) =>
                  Effect.provideService(
                    effect,
                    EnvironmentSupervisor.EnvironmentSupervisor,
                    supervisor,
                  ),
                followStream: (_id, stream) =>
                  Stream.provideService(
                    stream,
                    EnvironmentSupervisor.EnvironmentSupervisor,
                    supervisor,
                  ),
              } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
              const runtime = Atom.runtime(
                Layer.merge(
                  Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments),
                  Layer.succeed(Persistence.EnvironmentCacheStore, {
                    loadServerConfig: () => Effect.succeedNone,
                  } as unknown as Persistence.EnvironmentCacheStore["Service"]),
                ),
              );
              const atoms = createServerEnvironmentAtoms(runtime, {
                initialConfigValueAtom: () => Atom.make(CONFIG),
              });
              const registry = yield* Effect.acquireRelease(
                Effect.sync(AtomRegistry.make),
                (value) => Effect.sync(() => value.dispose()),
              );
              const history: Atom.Atom<
                AsyncResult.AsyncResult<{ readonly retainedSampleCount: number }, Error>
              > = atoms[atomKey]({
                environmentId: TARGET.environmentId,
                input: { windowMs: 900_000, bucketMs: 30_000 },
              });
              const unmount = registry.mount(history);
              const initial = yield* AtomRegistry.getResult(registry, history, {
                suspendOnWaiting: true,
              });
              expect(initial.retainedSampleCount).toBe(0);
              yield* Effect.promise(() => vi.advanceTimersByTimeAsync(5_000));
              expect(reads).toBe(2);
              const updated = yield* AtomRegistry.getResult(registry, history, {
                suspendOnWaiting: true,
              });
              expect(updated.retainedSampleCount).toBe(1);
              unmount();
              yield* Effect.promise(() => vi.advanceTimersByTimeAsync(10_000));
              expect(reads).toBe(2);
            }),
          );
        } finally {
          vi.useRealTimers();
        }
      }),
  );
});
