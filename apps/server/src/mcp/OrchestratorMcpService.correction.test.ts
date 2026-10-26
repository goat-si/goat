import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Correction admission tests never start providers"),
};
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("correction-destination"),
  requestNamespace: "correction-destination",
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  thread: undefined,
  client: { sessionId: "origin", label: "origin", access: "full-access" },
};

function fixture(response: { lost: boolean; beforeCommit: boolean }) {
  const database = Sqlite.layerMemory;
  const runtime = ProviderReplayHarness.layerWithRegistry(
    { name: "correction-destination" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  );
  const settings = ServerSettings.layerTest({
    goatclaw: { enabled: true, defaultProfile: "owner" },
  });
  const realThreads = ThreadManagement.layer.pipe(
    Layer.provide(runtime),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(database))),
    Layer.provide(settings),
  );
  const threads = Layer.effect(
    ThreadManagement.ThreadManagementService,
    Effect.gen(function* () {
      const actual = yield* ThreadManagement.ThreadManagementService;
      return ThreadManagement.ThreadManagementService.of({
        ...actual,
        sendToThread: (input) =>
          (response.beforeCommit
            ? Effect.fail(
                new Orchestrator.OrchestratorDispatchError({
                  commandId: input.commandId,
                  commandType: "message.dispatch",
                }),
              )
            : actual.sendToThread(input)
          ).pipe(
            Effect.flatMap((result) =>
              response.lost
                ? Effect.fail(
                    new Orchestrator.OrchestratorDispatchError({
                      commandId: input.commandId,
                      commandType: "message.dispatch",
                    }),
                  )
                : Effect.succeed(result),
            ),
          ),
      });
    }),
  ).pipe(Layer.provide(realThreads));
  return OrchestratorMcpService.layer.pipe(
    Layer.provide(layerNoFleetSync),
    Layer.provideMerge(
      Layer.mergeAll(
        runtime,
        threads,
        database,
        NodeServices.layer,
        settings,
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({}),
        Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({}),
      ),
    ),
  );
}

it.effect.each(["rejected", "accepted-lost", "precommit-lost"] as const)(
  "settles destination fence rejection but retains ambiguous delivery, boundary=%s",
  (boundary) => {
    const lost = boundary === "accepted-lost";
    const beforeCommit = boundary === "precommit-lost";
    const response = { lost, beforeCommit };
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const events = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("correction-target");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make("correction-project"),
        title: "Target",
        modelSelection: { instanceId, model: "fixture" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const finish = (name: string) =>
        Effect.gen(function* () {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(name),
            threadId,
            messageId: MessageId.make(name),
            text: name,
            attachments: [],
            dispatchMode: { type: "defer_start" },
            createdBy: "user",
            creationSource: "web",
          });
          const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
          const now = yield* DateTime.now;
          yield* events.write({
            commandId: CommandId.make(name + ":finish"),
            events: [
              {
                id: EventId.make(name + ":finished"),
                type: "run.updated",
                threadId,
                occurredAt: now,
                payload: { ...run, status: "failed", completedAt: now },
              },
            ],
          });
          return run.id;
        });
      const reviewed = yield* finish("reviewed");
      const latest = yield* finish("newer");
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const input = {
        threadId,
        message: "Correct",
        clientRequestId: "correction",
        expectedLatestRunId: lost || beforeCommit ? latest : reviewed,
        ...(beforeCommit ? { mode: "queue" as const } : {}),
      };
      const result = yield* service.sendToThread(scope, input).pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      const sql = yield* SqlClient.SqlClient;
      const slots = () =>
        sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM goatclaw_lane_reservations WHERE pending = 1`;
      assert.deepStrictEqual(yield* slots(), [{ count: lost || beforeCommit ? 1 : 0 }]);
      assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, lost ? 3 : 2);
      response.lost = false;
      response.beforeCommit = false;
      if (beforeCommit) {
        yield* service.sendToThread(scope, {
          threadId,
          message: "Unrelated run",
          clientRequestId: "unrelated-active",
        });
        assert.deepStrictEqual(yield* slots(), [{ count: 1 }]);
      }
      const reservationsBeforeRetry = yield* sql<{
        id: string;
        pending: number;
      }>`SELECT id, pending FROM goatclaw_lane_reservations ORDER BY id`;
      const targetBeforeRetry = yield* orchestrator.getThreadProjection(threadId);
      const replay = yield* service.sendToThread(scope, input).pipe(Effect.result);
      assert.strictEqual(replay._tag, lost ? "Success" : "Failure");
      assert.deepStrictEqual(yield* slots(), [{ count: 0 }]);
      assert.lengthOf(
        (yield* orchestrator.getThreadProjection(threadId)).runs,
        lost || beforeCommit ? 3 : 2,
      );
      if (beforeCommit) {
        assert.deepStrictEqual(
          yield* sql<{
            id: string;
            pending: number;
          }>`SELECT id, pending FROM goatclaw_lane_reservations ORDER BY id`,
          reservationsBeforeRetry.filter((reservation) => reservation.pending === 0),
        );
        const targetAfterRetry = yield* orchestrator.getThreadProjection(threadId);
        assert.deepStrictEqual(targetAfterRetry.runs, targetBeforeRetry.runs);
        assert.deepStrictEqual(targetAfterRetry.messages, targetBeforeRetry.messages);
        const active = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
        const now = yield* DateTime.now;
        yield* events.write({
          commandId: CommandId.make("unrelated-finish"),
          events: [
            {
              id: EventId.make("unrelated-finished"),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: { ...active, status: "failed", completedAt: now },
            },
          ],
        });
        const rejectedReplay = yield* service.sendToThread(scope, input).pipe(Effect.result);
        assert.strictEqual(rejectedReplay._tag, "Failure");
        assert.deepStrictEqual(yield* slots(), [{ count: 0 }]);
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 3);
      }
    }).pipe(Effect.provide(fixture(response)));
  },
);
