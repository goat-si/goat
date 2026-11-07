import { vi } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthSessionState,
  BotId,
  CHANNEL_GATEWAY_WS_METHODS,
  type ChannelUpdateBotInput,
  EnvironmentId,
  ThreadId,
} from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createChannelEnvironmentAtoms } from "./channels.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({
    sessionStateAtom: operatorSessions,
    initialConfigValueAtom: () => Atom.make(null),
  }),
}));
const operatorSessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(
    AsyncResult.success({
      authenticated: true,
      auth: {
        policy: "remote-reachable" as const,
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
    }),
  ),
);

const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("bot-home"),
  label: "Bot home",
  httpBaseUrl: "https://bot-home.example.test",
  wsBaseUrl: "wss://bot-home.example.test",
});

const botProfile = (name: string) => ({
  botId: BotId.make("main"),
  role: "main" as const,
  name,
  avatar: null,
  purpose: "",
  defaultModelSelection: null,
  defaultProjectId: null,
  environmentId: target.environmentId,
  sessionThreadId: ThreadId.make("bot-thread"),
  createdAt: "2026-11-07T00:00:00.000Z",
  updatedAt: "2026-11-07T00:00:00.000Z",
});

it.effect("shows a saved bot name in the list the settings row reads", () =>
  Effect.scoped(
    Effect.gen(function* () {
      // The server's stored profile: listBots reads it, updateBot writes it.
      let stored = botProfile("GOAT Bot");
      const client = {
        [CHANNEL_GATEWAY_WS_METHODS.listBots]: () => Effect.sync(() => ({ bots: [stored] })),
        [CHANNEL_GATEWAY_WS_METHODS.updateBot]: (input: ChannelUpdateBotInput) =>
          Effect.sync(() => {
            stored = { ...stored, ...(input.name === undefined ? {} : { name: input.name }) };
            return { bot: stored };
          }),
      } as unknown as WsRpcProtocolClient;
      const connectionState: SupervisorConnectionState = {
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        network: "online",
        phase: "connected",
        attempt: 1,
        generation: 1,
      };
      const rpcSession: RpcSession = {
        client,
        initialConfig: Effect.never,
        subscribeServerConfig: () => Stream.never,
        ready: Effect.void,
        probe: Effect.void,
        inboundFrames: Effect.succeed(0),
        closed: Effect.never,
      };
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target,
        state: yield* SubscriptionRef.make(connectionState),
        session: yield* SubscriptionRef.make(Option.some(rpcSession)),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const environments = EnvironmentRegistry.EnvironmentRegistry.of({
        entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
          new Map([[target.environmentId, { target, profile: Option.none(), enabled: true }]]),
        ),
        run: (_environmentId, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        runStream: (_environmentId, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        followStream: (_environmentId, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
      const atoms = createChannelEnvironmentAtoms(
        Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments)),
      );
      const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
        Effect.sync(() => registry.dispose()),
      );
      const list = atoms.listBots({ environmentId: target.environmentId, input: {} });
      const unmount = registry.mount(list);
      yield* Effect.addFinalizer(() => Effect.sync(unmount));
      const names = Effect.map(
        AtomRegistry.getResult(registry, list, { suspendOnWaiting: true }),
        (result) => result.bots.map((bot) => bot.name),
      );
      expect(yield* names).toEqual(["GOAT Bot"]);
      const saved = yield* Effect.promise(() =>
        atoms.updateBot.run(registry, {
          environmentId: target.environmentId,
          input: { botId: BotId.make("main"), name: "Jarvis" },
        }),
      );
      expect(AsyncResult.isSuccess(saved)).toBe(true);
      expect(yield* names).toEqual(["Jarvis"]);
    }),
  ),
);
