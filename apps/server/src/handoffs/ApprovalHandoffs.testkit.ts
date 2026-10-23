/**
 * A running turn on the real orchestrator with the real handoff service, for tests of approval
 * handoffs and the flows built on them.
 *
 * @module ApprovalHandoffs.testkit
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AuthClientSession,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as SecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Worker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { makeFakeCloudAdapter } from "../orchestration-v2/testkit/FakeCloudAdapter.ts";
import * as Harness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ApprovalHandoffs from "./ApprovalHandoffs.ts";
import * as Handoffs from "./Handoffs.ts";

export const threadId = ThreadId.make("thread:approval");
export const instanceId = ProviderInstanceId.make("codex");
const environmentId = EnvironmentId.make("origin");
/** The person's session that answers handoffs. */
export const person = AuthSessionId.make("session:person");

/**
 * A running turn on the real orchestrator, the real handoff service, and a person's session. The
 * turn is a person's message from the web app unless `startedBy` is "agent".
 */
export const withApprovals = <A, E, R>(
  body: (input: {
    readonly approvals: ApprovalHandoffs.ApprovalHandoffs["Service"];
    readonly handoffs: Handoffs.Handoffs["Service"];
  }) => Effect.Effect<A, E, R>,
  options: { readonly startedBy?: "person" | "agent" } = {},
) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeCloudAdapter(true, instanceId);
    const adapter = {
      ...fake.adapter,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      openSession: (session: Parameters<typeof fake.adapter.openSession>[0]) =>
        fake.adapter
          .openSession(session)
          .pipe(Effect.map((opened) => ({ ...opened, startTurn: () => Effect.void }))),
    };
    const databaseLayer = Sqlite.layerMemory;
    return yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* Worker.OrchestrationEffectWorkerV2;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-thread"),
        threadId,
        projectId: ProjectId.make("project:approval"),
        title: "Hub change",
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
        messageId: MessageId.make("message:approval"),
        text: "Join the device",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        ...(options.startedBy === "agent"
          ? { createdBy: "agent" as const, creationSource: "server" as const }
          : { createdBy: "user" as const, creationSource: "web" as const }),
      });
      yield* worker.drain();
      const now = yield* DateTime.now;
      const session: AuthClientSession = {
        sessionId: person,
        subject: "browser",
        method: "browser-session-cookie",
        scopes: ["orchestration:operate", "settings:write"],
        client: { label: "Laptop", deviceType: "unknown" },
        issuedAt: now,
        expiresAt: DateTime.add(now, { days: 7 }),
        lastConnectedAt: now,
        connected: true,
        current: true,
      };
      const environment = Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(environmentId),
      });
      const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
        dispatch: orchestrator.dispatch,
        getThreadRecords: orchestrator.getThreadRecords,
      });
      const handoffLayer = Handoffs.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            threads,
            environment,
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(SessionStore.SessionStore)({
              cookieName: "test",
              legacyCookieName: undefined,
              listActive: () => Effect.succeed([session]),
            }),
            Layer.succeed(
              SecretStore.ServerSecretStore,
              SecretStore.ServerSecretStore.of({
                get: () => Effect.succeed(Option.none()),
                set: () => Effect.void,
                create: () => Effect.void,
                remove: () => Effect.void,
                getOrCreateRandom: (_name, size) => Effect.succeed(new Uint8Array(size).fill(3)),
              }),
            ),
          ),
        ),
      );
      return yield* Effect.gen(function* () {
        return yield* body({
          approvals: yield* ApprovalHandoffs.ApprovalHandoffs,
          handoffs: yield* Handoffs.Handoffs,
        });
      }).pipe(
        Effect.provide(
          ApprovalHandoffs.layer.pipe(
            Layer.provideMerge(handoffLayer),
            Layer.provide(threads),
            Layer.provide(environment),
          ),
        ),
      );
    }).pipe(
      Effect.provide(
        Harness.layerWithRegistry(
          { name: "approval-handoffs" },
          Registry.layerFromAdapters([adapter]),
          { runEffectWorker: false, databaseLayer },
        ).pipe(Layer.provideMerge(databaseLayer)),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);
