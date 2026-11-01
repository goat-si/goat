import { expect, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProviderDriverKind,
  RunId,
  ThreadId,
  type AuthEnvironmentScope,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Persistence from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as Receipts from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as Sessions from "./ProviderSessionManager.ts";
import * as Threads from "./ThreadManagementService.ts";

it.effect(
  "projects current destination constraints on every thread read without rewriting history",
  () =>
    Effect.gen(function* () {
      const shell = liveThreadShell(ThreadId.make("access-parent"));
      const now = yield* DateTime.now;
      const run: OrchestrationV2Run = {
        id: RunId.make("access-run"),
        delegatedTaskId: NodeId.make("access-child"),
        threadId: shell.id,
        ordinal: 1,
        providerInstanceId: shell.providerInstanceId,
        modelSelection: shell.modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("access-message"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
        memoryGrantCeiling: "read_write",
      };
      const task: OrchestrationV2Subagent = {
        id: NodeId.make("access-child"),
        threadId: shell.id,
        runId: run.id,
        parentNodeId: NodeId.make("access-node"),
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: shell.providerInstanceId,
        providerThreadId: null,
        childThreadId: ThreadId.make("access-child-thread"),
        nativeTaskRef: null,
        prompt: "Synthetic work",
        title: null,
        model: null,
        status: "completed",
        result: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        memoryGrantCeiling: "read_write",
      };
      const source = {
        ...idleThreadProjection(shell),
        runs: [run],
        subagents: [
          task,
          {
            ...task,
            id: NodeId.make("access-remote"),
            remote: { host: "remote", threadId: null, correlationId: "synthetic" },
          },
          { ...task, id: NodeId.make("access-native"), origin: "provider_native" as const },
        ],
      };
      const snapshot = { schemaVersion: 2, snapshotSequence: 7, projection: source };
      let recordsSource = source;
      const prepared = {
        threadId: shell.id,
        providerInstanceId: shell.providerInstanceId,
        runId: run.id,
        delegatedTaskId: task.id,
        memoryGrantCeiling: "read_write" as const,
      };
      let inputs: Sessions.ProviderMemoryPrepareInput | undefined = { ...prepared, readOnly: true };
      let memoryAccessInputCalls = 0;
      let currentMemoryGrant = "read" as "read" | "read_write";
      const settingsLayer = Settings.layerTest();
      const layer = Threads.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            settingsLayer,
            Receipts.layer.pipe(Layer.provide(Persistence.layerMemory)),
            Layer.mock(Sessions.ProviderSessionManagerV2)({
              memoryAccessInputs: (_thread, provider) =>
                Effect.sync(() => {
                  memoryAccessInputCalls++;
                  return provider === shell.providerInstanceId && inputs
                    ? { ...inputs, currentMemoryGrant }
                    : undefined;
                }),
            }),
            Layer.mock(Orchestrator.OrchestratorV2)({
              getThreadProjection: () => Effect.succeed(source),
              getThreadSnapshot: () => Effect.succeed(snapshot),
              getThreadSnapshotWindow: () => Effect.succeed(snapshot),
              getThreadRecords: () => Effect.succeed(recordsSource),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const threads = yield* Threads.ThreadManagementService;
        const settings = yield* Settings.ServerSettingsService;
        const projections = [
          yield* threads.getThreadProjection(shell.id),
          (yield* threads.getThreadSnapshot(shell.id)).projection,
          (yield* threads.getThreadSnapshotWindow(shell.id, { rowLimit: 10 })).projection,
          yield* threads.getThreadRecords(shell.id, ["runs", "subagents"]),
          yield* threads.getProjectThreadRecords(
            { projectId: shell.projectId, threadId: shell.id },
            ["runs", "subagents"],
          ),
        ];
        for (const projected of projections) {
          expect(projected.runs[0]?.currentMemoryAccess).toEqual({
            access: "read",
            reason: "read_only_destination",
          });
          expect(projected.subagents[0]).not.toHaveProperty("currentMemoryAccess");
          expect(projected.subagents[1]).not.toHaveProperty("currentMemoryAccess");
          expect(projected.subagents[2]).not.toHaveProperty("currentMemoryAccess");
          expect(projected.runs[0]?.status).toBe("completed");
        }
        inputs = {
          ...prepared,
          readOnly: false,
          dispatchScopes: ["memory:read"] as ReadonlyArray<AuthEnvironmentScope>,
        };
        expect((yield* threads.getThreadProjection(shell.id)).runs[0]?.currentMemoryAccess).toEqual(
          { access: "read", reason: "dispatch_scope" },
        );
        inputs = {
          ...prepared,
          runId: RunId.make("different-run"),
          delegatedTaskId: NodeId.make("different-task"),
        };
        expect((yield* threads.getThreadProjection(shell.id)).runs[0]).not.toHaveProperty(
          "currentMemoryAccess",
        );
        expect((yield* threads.getThreadProjection(shell.id)).subagents[0]).not.toHaveProperty(
          "currentMemoryAccess",
        );
        inputs = { ...prepared, memoryGrantCeiling: "read" };
        expect((yield* threads.getThreadProjection(shell.id)).runs[0]).not.toHaveProperty(
          "currentMemoryAccess",
        );
        inputs = undefined;
        expect((yield* threads.getThreadProjection(shell.id)).runs[0]).not.toHaveProperty(
          "currentMemoryAccess",
        );
        yield* settings.updateSettings({ enableAgentMemoryAccess: false });
        expect((yield* threads.getThreadProjection(shell.id)).runs[0]?.currentMemoryAccess).toEqual(
          { access: "none", reason: "environment_off" },
        );
        yield* settings.updateSettings({ enableAgentMemoryAccess: true });
        inputs = { ...prepared, readOnly: false };
        // Positive DTOs use execution's grant even if prepare metadata alone
        // would infer write access.
        expect((yield* threads.getThreadProjection(shell.id)).runs[0]?.currentMemoryAccess).toEqual(
          { access: "read", reason: "ceiling" },
        );
        currentMemoryGrant = "read_write";
        expect((yield* threads.getThreadProjection(shell.id)).runs[0]?.currentMemoryAccess).toEqual(
          { access: "read_write", reason: "ceiling" },
        );
        // Full records may include an unbounded history of positive ceilings.
        const pastRuns = Array.from({ length: 32 }, (_, index) => ({
          ...run,
          id: RunId.make(`past-access-run-${index}`),
          ordinal: index + 2,
        }));
        recordsSource = { ...source, runs: [...pastRuns, run] };
        memoryAccessInputCalls = 0;
        const records = yield* threads.getThreadRecords(shell.id, ["runs"]);
        expect(memoryAccessInputCalls).toBe(1);
        for (const past of records.runs.slice(0, -1)) {
          expect(past).not.toHaveProperty("currentMemoryAccess");
        }
        expect(records.runs.at(-1)?.currentMemoryAccess).toEqual({
          access: "read_write",
          reason: "ceiling",
        });
        // A new response must evaluate execution policy again.
        currentMemoryGrant = "read";
        const nextRecords = yield* threads.getThreadRecords(shell.id, ["runs"]);
        expect(memoryAccessInputCalls).toBe(2);
        expect(nextRecords.runs.at(-1)?.currentMemoryAccess?.access).toBe("read");
        for (const past of nextRecords.runs.slice(0, -1)) {
          expect(past).not.toHaveProperty("currentMemoryAccess");
        }
        currentMemoryGrant = "read_write";
        // Destination rejection does not force the lazy execution judgment.
        recordsSource = { ...recordsSource, thread: { ...source.thread, archivedAt: now } };
        memoryAccessInputCalls = 0;
        yield* threads.getThreadRecords(shell.id, ["runs"]);
        expect(memoryAccessInputCalls).toBe(0);
        for (const destination of [
          { ...source.thread, archivedAt: now },
          { ...source.thread, deletedAt: now },
          {
            ...source.thread,
            providerInstanceId: "other-provider" as typeof shell.providerInstanceId,
          },
        ]) {
          recordsSource = { ...source, thread: destination };
          expect((yield* threads.getThreadRecords(shell.id, ["runs"])).runs[0]).not.toHaveProperty(
            "currentMemoryAccess",
          );
        }
        recordsSource = source;
        expect(source.runs[0]).not.toHaveProperty("currentMemoryAccess");
        expect(source.runs[0]?.memoryGrantCeiling).toBe("read_write");
        expect(source.subagents[0]).not.toHaveProperty("currentMemoryAccess");
        // A runs-only scheduled read has no message provenance or delegated task id.
        const { delegatedTaskId: _taskId, ...scheduledRun } = run;
        recordsSource = { ...source, runs: [scheduledRun], messages: [] };
        expect(
          (yield* threads.getProjectThreadRecords(
            { projectId: shell.projectId, threadId: shell.id },
            ["runs"],
          )).runs[0]?.currentMemoryAccess,
        ).toEqual({ access: "read_write", reason: "ceiling" });
        yield* settings.updateSettings({ enableAgentMemoryAccess: false });
        expect(
          (yield* threads.getThreadRecords(shell.id, ["runs"])).runs[0]?.currentMemoryAccess,
        ).toEqual({ access: "none", reason: "environment_off" });
        // An ordinary user admission's null ceiling cannot establish task permission.
        inputs = { ...prepared, memoryGrantCeiling: null };
        expect((yield* threads.getThreadRecords(shell.id, ["runs"])).runs[0]).not.toHaveProperty(
          "currentMemoryAccess",
        );

        expect(
          yield* threads.getProjectThreadRecords(
            { projectId: shell.projectId, threadId: shell.id },
            [],
          ),
        ).toBeDefined();
      }).pipe(Effect.provide(layer));
    }),
);
