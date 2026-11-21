import { EventId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { layerSessionStore } from "../auth/SessionEnd.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as OrchestratorMcp from "../mcp/OrchestratorMcpService.ts";
import { layerOrchestratorService } from "../mcp/OrchestratorMcpService.testkit.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderTurnStart from "../orchestration-v2/ProviderTurnStartService.ts";
import { nextTurnSelectionHarness } from "../orchestration-v2/testkit/SteeringHarness.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import { appendChannelBotNote, channelBotFilesFor } from "./channelBotNotes.ts";
import { ask, sessionHarness } from "./ChannelBotSession.testkit.ts";
import {
  environmentId,
  makeHarness,
  memoryRpcContext,
  setupBot,
} from "./testkit/ChannelHarness.ts";

const layerMcpRead = layerOrchestratorService.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeCrypto.layer,
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({}),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({}),
    ),
  ),
);

describe("GOAT Bot thread transcripts", () => {
  it.effect.each(["worker", "session"] as const)(
    "keeps the %s notes out of an ordinary MCP thread read",
    (kind) => {
      return Effect.gen(function* () {
        const provider = yield* nextTurnSelectionHarness("channel-private-prompt");
        const harness =
          kind === "worker"
            ? makeHarness({
                realWorkerLaunch: true,
                workspaceRoot: import.meta.dirname,
                workerAdapter: provider.adapter,
              })
            : sessionHarness({
                realWorkerLaunch: true,
                botWorkspaceRoot: provider.cwd,
                workerAdapter: provider.adapter,
              });
        yield* Effect.gen(function* () {
          yield* setupBot;
          const files = channelBotFilesFor(
            yield* Path.Path,
            (yield* ServerConfig.ServerConfig).stateDir,
          );
          const note = "Use the Juniper checklist for the staging rollout.";
          yield* appendChannelBotNote(
            yield* FileSystem.FileSystem,
            files,
            note,
            "2026-11-21T00:00:00Z",
            "fixture",
          );
          const instruction = "Check the staging rollout";
          const task = yield* ask(
            (kind === "worker" ? "do: " : "look: ") + instruction,
            "private-transcript",
            memoryRpcContext,
          );
          const threadId = task.worker?.threadId;
          if (threadId === undefined) return yield* Effect.die("The task did not launch");
          const mcp = yield* OrchestratorMcp.OrchestratorMcpService;
          const result = yield* mcp.readThread(
            {
              environmentId,
              requestNamespace: "client:read-without-memory",
              capabilities: new Set(["orchestration"]),
              grantedScopes: ["orchestration:read"],
              issuedAt: 0,
              thread: undefined,
              client: { sessionId: "read-without-memory", label: "Reader", access: "read-only" },
            },
            { threadId, maxCharsPerItem: 20_000 },
          );
          const userMessage = result.items.find((item) => item.type === "user_message");
          assert.notInclude(JSON.stringify(result), note);
          assert.strictEqual(userMessage?.text, instruction);

          const runId = task.worker?.runId;
          if (runId === undefined) return yield* Effect.die("No worker run");
          yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({ threadId, runId });
          assert.include(provider.started[0]?.message.text ?? "", note);
        }).pipe(Effect.provide(layerMcpRead), Effect.provide(harness.layer));
      });
    },
  );
  it.effect("settles a warm queued turn whose app session is revoked before provider start", () =>
    Effect.gen(function* () {
      const provider = yield* nextTurnSelectionHarness("channel-queued-private");
      const harness = sessionHarness({
        realWorkerLaunch: true,
        botWorkspaceRoot: provider.cwd,
        workerAdapter: provider.adapter,
      });
      yield* Effect.gen(function* () {
        yield* setupBot;
        const fs = yield* FileSystem.FileSystem;
        const files = channelBotFilesFor(
          yield* Path.Path,
          (yield* ServerConfig.ServerConfig).stateDir,
        );
        yield* appendChannelBotNote(
          fs,
          files,
          "Always check the Juniper runbook.",
          "2026-11-21T00:00:00Z",
          "fixture",
        );
        const sessions = yield* SessionStore.SessionStore;
        const issue = sessions.issue({
          subject: memoryRpcContext.principalId,
          scopes: memoryRpcContext.grantedScopes,
        });
        const opener = yield* issue;
        const queuedSender = yield* issue;
        const first = yield* ask("look: check the deploy", "warm-first", {
          ...memoryRpcContext,
          authSessionId: opener.sessionId,
        });
        const threadId = first.worker?.threadId;
        const firstRun = first.worker?.runId;
        if (threadId === undefined || firstRun === undefined)
          return yield* Effect.die("No warm session");
        const starts = yield* ProviderTurnStart.ProviderTurnStartServiceV2;
        yield* starts.start({ threadId, runId: firstRun });
        const started = provider.started[0];
        if (started === undefined) return yield* Effect.die("No first provider turn");
        const second = yield* ask("look: verify the health page", "warm-queued", {
          ...memoryRpcContext,
          authSessionId: queuedSender.sessionId,
        });
        const queued = second.worker?.runId;
        assert.strictEqual(second.worker?.threadId, threadId);
        if (queued === undefined) return yield* Effect.die("No queued warm run");
        const threads = yield* ThreadManagement.ThreadManagementService;
        const readRun = threads
          .getThreadRecords(threadId, ["runs"])
          .pipe(Effect.map((records) => records.runs.find((run) => run.id === queued)));
        assert.strictEqual((yield* readRun)?.status, "queued");
        yield* sessions.revoke(queuedSender.sessionId);

        const active = (yield* threads.getThreadRecords(threadId, ["runs"])).runs.find(
          (run) => run.id === firstRun,
        );
        if (active?.status !== "running") return yield* Effect.die("The first run was not active");
        const now = yield* DateTime.now;
        yield* (yield* EventSink.EventSinkV2).write({
          events: [
            {
              id: EventId.make("event:previous-turn-settled"),
              type: "run.updated",
              threadId,
              runId: active.id,
              occurredAt: now,
              providerInstanceId: active.providerInstanceId,
              payload: { ...active, status: "completed", completedAt: now },
            },
          ],
        });
        yield* (yield* Orchestrator.OrchestratorV2).resumeQueuedRuns;
        assert.strictEqual((yield* readRun)?.status, "starting");
        yield* starts.start({ threadId, runId: queued });
        assert.lengthOf(provider.started, 1);
        assert.strictEqual((yield* readRun)?.status, "failed");
      }).pipe(
        Effect.provide(
          harness.layer.pipe(
            Layer.provideMerge(Layer.mergeAll(SqlitePersistence.layerMemory, layerSessionStore)),
          ),
        ),
      );
    }),
  );
});
