import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  WS_METHODS,
  type ServerConfig,
  type AuthSessionState,
} from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
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

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make(
    AsyncResult.success({
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: ["providers:manage"],
      permissions: ["providers:manage"],
    } as AuthSessionState),
  ),
);

it.effect("toggles a provider while another provider's update is still running", () =>
  Effect.gen(function* () {
    const updateStarted = yield* Deferred.make<void>();
    const settingsSaved = yield* Deferred.make<void>();
    const client = {
      [WS_METHODS.serverUpdateProvider]: () =>
        Deferred.succeed(updateStarted, undefined).pipe(Effect.andThen(Effect.never)),
      [WS_METHODS.serverUpdateSettings]: () =>
        Deferred.succeed(settingsSaved, undefined).pipe(Effect.as(CONFIG.settings)),
    } as unknown as WsRpcProtocolClient;
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target: TARGET,
      state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
      session: yield* SubscriptionRef.make(Option.some(session(client))),
      prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
    const runtime = Atom.runtime(
      Layer.merge(
        Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
          run: (_environmentId, effect) =>
            Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
        Layer.succeed(
          Persistence.EnvironmentCacheStore,
          {} as Persistence.EnvironmentCacheStore["Service"],
        ),
      ),
    );
    const atoms = createServerEnvironmentAtoms(runtime, {
      initialConfigValueAtom: () => Atom.make(CONFIG),
    });
    const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
      Effect.sync(() => registry.dispose()),
    );

    void atoms.updateProvider.run(registry, {
      environmentId: TARGET.environmentId,
      input: { provider: ProviderDriverKind.make("opencode") },
    });
    yield* Deferred.await(updateStarted);
    void atoms.mutateProviderInstance.run(registry, {
      environmentId: TARGET.environmentId,
      input: {
        patch: {},
        providerInstanceMutation: {
          operation: "upsert",
          instanceId: ProviderInstanceId.make("codex"),
          instance: { driver: ProviderDriverKind.make("codex"), enabled: false },
        },
      },
    });

    const saved = yield* Deferred.await(settingsSaved).pipe(
      Effect.as(true),
      Effect.timeoutOrElse({
        duration: Duration.seconds(1),
        orElse: () => Effect.succeed(false),
      }),
      Effect.forkChild,
    );
    yield* TestClock.adjust(Duration.seconds(1));
    expect(yield* Fiber.join(saved)).toBe(true);
  }).pipe(Effect.scoped),
);
