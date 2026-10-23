import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
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
import * as TestClock from "effect/testing/TestClock";

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

const threadId = ThreadId.make("thread:approval");
const instanceId = ProviderInstanceId.make("codex");
const environmentId = EnvironmentId.make("origin");
const person = AuthSessionId.make("session:person");
const targetPath = "hub.device_join";
const binding = { binding: "goat-hub-binding: join lidge-ts SHA256:key" };

/** A running turn on the real orchestrator, the real handoff service, and a person's session. */
const withApprovals = <A, E>(
  body: (input: {
    readonly approvals: ApprovalHandoffs.ApprovalHandoffs["Service"];
    readonly handoffs: Handoffs.Handoffs["Service"];
  }) => Effect.Effect<A, E>,
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
        createdBy: "user",
        creationSource: "web",
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

const ask = (approvals: ApprovalHandoffs.ApprovalHandoffs["Service"]) =>
  Effect.gen(function* () {
    return yield* approvals.request({
      threadId,
      providerInstanceId: instanceId,
      targetPath,
      title: "Join lidge-ts to the hub",
      reason: "GOAT has no pinned host key for this alias.",
      location: "Approving links lidge-ts as a Remote Link Child.",
      binding,
      expiresAt: DateTime.add(yield* DateTime.now, { hours: 1 }),
    });
  });

it.effect("a person's approval covers exactly the change it was asked for, until it expires", () =>
  withApprovals(({ approvals, handoffs }) =>
    Effect.gen(function* () {
      const summary = yield* ask(approvals);
      const check = (input: { readonly targetPath?: string; readonly binding?: object }) =>
        approvals
          .verify({
            threadId,
            handoffId: summary.handoffId,
            targetPath: input.targetPath ?? targetPath,
            binding: { ...(input.binding ?? binding) },
          })
          .pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => "approved" }));
      expect(yield* check({})).toContain("still open");
      yield* handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "completed" },
        person,
      );
      expect(yield* check({})).toBe("approved");
      expect(
        yield* check({ binding: { binding: "goat-hub-binding: join lidge-ts SHA256:other" } }),
      ).toContain("does not cover");
      expect(yield* check({ targetPath: "hub.device_leave" })).toContain("does not cover");
      yield* TestClock.adjust("2 hours");
      expect(yield* check({})).toContain("expired");
    }),
  ),
);

it.effect("a declined approval approves nothing", () =>
  withApprovals(({ approvals, handoffs }) =>
    Effect.gen(function* () {
      const summary = yield* ask(approvals);
      yield* handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "declined" },
        person,
      );
      const result = yield* approvals
        .verify({ threadId, handoffId: summary.handoffId, targetPath, binding })
        .pipe(Effect.flip);
      expect(result.message).toContain("was not given");
    }),
  ),
);
