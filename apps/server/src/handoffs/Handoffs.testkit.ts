import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type AuthClientSession,
  AuthSessionId,
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as SecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Worker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { makeFakeCloudAdapter } from "../orchestration-v2/testkit/FakeCloudAdapter.ts";
import * as Harness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Handoffs from "./Handoffs.ts";

export const threadId = ThreadId.make("thread:handoff-tests");
export const instanceId = ProviderInstanceId.make("codex");
/** An orchestrator thread with a running turn, which handoffs belong to. */
export const withHarness = <A, E, R>(
  body: (input: {
    orchestrator: Orchestrator.OrchestratorV2["Service"];
    worker: Worker.OrchestrationEffectWorkerV2["Service"];
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeCloudAdapter(true, instanceId);
    const adapter = {
      ...fake.adapter,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      openSession: (input: Parameters<typeof fake.adapter.openSession>[0]) =>
        fake.adapter
          .openSession(input)
          .pipe(Effect.map((session) => ({ ...session, startTurn: () => Effect.void }))),
    };
    const databaseLayer = Sqlite.layerMemory;
    return yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* Worker.OrchestrationEffectWorkerV2;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-thread"),
        threadId,
        projectId: ProjectId.make("project:handoff-tests"),
        title: "Human handoff",
        modelSelection: { instanceId, model: "fake" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("start-run"),
        threadId,
        messageId: MessageId.make("message:handoff"),
        text: "Set up the provider",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();
      return yield* body({ orchestrator, worker });
    }).pipe(
      Effect.provide(
        Harness.layerWithRegistry(
          { name: "human-handoff" },
          Registry.layerFromAdapters([adapter]),
          { runEffectWorker: false, databaseLayer },
        ).pipe(Layer.provideMerge(databaseLayer)),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

/**
 * Handoffs over the harness database and a temp secret store. Each `start` builds a fresh
 * service on the same storage, which is how a test restarts the server.
 */
export const durableHandoffs = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  options: {
    readonly environmentId: EnvironmentId;
    readonly sessions: Effect.Effect<ReadonlyArray<AuthClientSession>>;
  },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-handoffs-" });
    const store = Context.get(
      yield* Layer.build(
        SecretStore.layer.pipe(
          Layer.provide(ServerConfig.layerTest(home, { prefix: "handoffs-" })),
        ),
      ),
      SecretStore.ServerSecretStore,
    );
    const dependencies = Layer.mergeAll(
      Layer.succeed(SecretStore.ServerSecretStore, store),
      Layer.mock(Environment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(options.environmentId),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        dispatch: orchestrator.dispatch,
        getThreadRecords: orchestrator.getThreadRecords,
      }),
      Layer.mock(SessionStore.SessionStore)({
        cookieName: "test",
        legacyCookieName: undefined,
        listActive: () => options.sessions,
      }),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    const start = Layer.build(Layer.fresh(Handoffs.layer).pipe(Layer.provide(dependencies))).pipe(
      Effect.map((context) => Context.get(context, Handoffs.Handoffs)),
    );
    return { store, start };
  });

/**
 * Two people's clients on one environment for computer use grants: an owner who may change its
 * settings and an operator who may only operate, with stores the grants need.
 */
export const computerUseGrantClients = (orchestrator: Orchestrator.OrchestratorV2["Service"]) =>
  Effect.gen(function* () {
    const stored = new Map<string, Uint8Array>();
    const now = yield* DateTime.now;
    const session = (id: string, permissions: NonNullable<AuthClientSession["permissions"]>) =>
      ({
        sessionId: AuthSessionId.make(id),
        subject: "test",
        method: "browser-session-cookie",
        scopes: ["orchestration:operate"],
        permissions,
        client: { label: id, deviceType: "unknown" },
        issuedAt: now,
        expiresAt: DateTime.add(now, { days: 1 }),
        lastConnectedAt: now,
        connected: true,
        current: true,
      }) satisfies AuthClientSession;
    const owner = session("owner", ["orchestration:operate", "settings:write"]);
    const operator = session("operator", ["orchestration:operate"]);
    const environmentId = EnvironmentId.make("test-environment");
    const dependencies = Layer.mergeAll(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        dispatch: orchestrator.dispatch,
        getThreadRecords: orchestrator.getThreadRecords,
      }),
      Layer.mock(SessionStore.SessionStore)({
        cookieName: "test",
        legacyCookieName: undefined,
        listActive: () => Effect.succeed([owner, operator]),
      }),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(Environment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(environmentId),
      }),
      Layer.succeed(
        SecretStore.ServerSecretStore,
        SecretStore.ServerSecretStore.of({
          get: (name) => Effect.sync(() => Option.fromNullishOr(stored.get(name))),
          set: (name, value) => Effect.sync(() => void stored.set(name, value)),
          create: (name, value) => Effect.sync(() => void stored.set(name, value)),
          remove: (name) => Effect.sync(() => void stored.delete(name)),
          getOrCreateRandom: (name, size) =>
            Effect.sync(() => {
              const bytes = stored.get(name) ?? new Uint8Array(size).fill(7);
              stored.set(name, bytes);
              return bytes;
            }),
        }),
      ),
    );
    return { owner, operator, environmentId, dependencies };
  });
