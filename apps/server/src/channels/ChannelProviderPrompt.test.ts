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
});
