import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProviderDriverKind,
  EnvironmentAuthorizationError,
  EnvironmentId,
  Project,
  ProviderInstanceId,
  ScheduledTaskId,
  ScheduledTaskUpsertInput,
  ThreadId,
  type AuthEnvironmentScope,
  type MemoryTaskGrantCeiling,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Store from "../orchestration-v2/ProjectionStore.ts";
import * as Replay from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { runMemoryPrepareInput } from "../orchestration-v2/RunExecutionService.ts";
import * as Mcp from "../mcp/OrchestratorMcpService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Persistence from "../persistence/Sqlite.ts";
import * as Projects from "../project/ProjectService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Adapters from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Remote from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as Ssh from "../sshRemote/SshRemoteDispatch.ts";
import * as Secrets from "../secrets/SecretRequests.ts";
import * as Settings from "../serverSettings.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { captureRpcMemoryGrantCeiling } from "../auth/RpcAuthorization.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Tasks from "./ScheduledTaskService.ts";

const decodePublicInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

const at = "2026-10-15T00:00:00.000Z";
const shell = liveThreadShell(ThreadId.make("memory-task-caller"));
const project = Schema.decodeUnknownSync(Project)({
  id: shell.projectId,
  title: "Fixture",
  workspaceRoot: "/fixture",
  defaultModelSelection: shell.modelSelection,
  scripts: [],
  createdAt: at,
  updatedAt: at,
  deletedAt: null,
});
const publicInput: ScheduledTaskUpsertInput = {
  title: "Fixture",
  prompt: "Work",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId: shell.projectId,
  threadId: null,
  workspaceStrategy: { type: "root" },
  modelSelection: shell.modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
};

it.effect(
  "persists MCP caller captures, rebuilds on the same SQLite file, and fires both bindings",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-task-ceiling-" });
      const dbPath = `${directory}/state.sqlite`;
      yield* TestClock.setTime(Date.parse(at));
      let revoked = false;
      const caller = (
        managed: boolean,
        scopes: ReadonlyArray<AuthEnvironmentScope>,
      ): McpInvocationScope => ({
        environmentId: EnvironmentId.make("fixture"),
        requestNamespace: managed ? "managed" : "oauth",
        capabilities: new Set(["orchestration"]),
        issuedAt: 0,
        client: managed
          ? undefined
          : { sessionId: "fixture", label: "fixture", access: "full-access" },
        thread: managed
          ? {
              threadId: shell.id,
              providerInstanceId: ProviderInstanceId.make("codex"),
              providerSessionId: "fixture",
            }
          : undefined,
        grantedScopes: scopes,
        reauthorize: () =>
          revoked
            ? Effect.fail(
                new EnvironmentAuthorizationError({
                  message: "fixture revoked",
                  requiredScope: "memory:read",
                }),
              )
            : Effect.void,
      });
      const expected = new Map<string, MemoryTaskGrantCeiling>();
      const dispatched: Array<{ id: string; ceiling: MemoryTaskGrantCeiling; bound: boolean }> = [];
      let due: Effect.Effect<void> = Effect.die("scheduler not registered");
      const phaseLayer = () => {
        const databaseLayer = Persistence.layerFromPath(dbPath).pipe(
          Layer.provide(NodeServices.layer),
        );
        const adapter = {
          instanceId: shell.providerInstanceId,
          driver: ProviderDriverKind.make("codex"),
          getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
          openSession: () => Effect.die("Provider consumption belongs to L2"),
        } as ProviderAdapter.ProviderAdapterV2["Service"];
        const runtime = Replay.layerWithRegistry(
          { name: "scheduled-memory-ceiling" },
          Adapters.layerFromAdapters([adapter]),
          { databaseLayer, runEffectWorker: false },
        );
        const delivery = Layer.unwrap(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const store = yield* Store.ProjectionStoreV2;
            const createThread = (threadId: ThreadId, commandId: CommandId) =>
              orchestrator.dispatch({
                type: "thread.create",
                commandId,
                threadId,
                projectId: shell.projectId,
                title: "Fixture",
                modelSelection: shell.modelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdBy: "agent",
                creationSource: "mcp",
              });
            // Delivery ports stop before provider startup, but use the real event sink and projections.
            const dispatch = (
              threadId: ThreadId,
              input: Parameters<Threads.ThreadManagementService["Service"]["sendToThread"]>[0],
              bound: boolean,
            ) =>
              Effect.gen(function* () {
                const dispatchedCommand = yield* orchestrator.dispatch({
                  type: "message.dispatch",
                  commandId: input.commandId!,
                  threadId,
                  messageId: input.messageId,
                  text: input.text,
                  attachments: input.attachments,
                  scheduledTaskId: input.scheduledTaskId!,
                  memoryGrantCeiling: input.memoryGrantCeiling ?? "none",
                  modelSelection: shell.modelSelection,
                  dispatchMode: { type: "queue_after_active" },
                  createdBy: input.createdBy,
                  creationSource: input.creationSource,
                });
                const projection = yield* store.getThreadProjection(threadId);
                const run = projection.runs.find((r) => r.userMessageId === input.messageId)!;
                const message = projection.messages.find((m) => m.id === input.messageId)!;
                assert.equal(run.memoryGrantCeiling, expected.get(input.scheduledTaskId!));
                assert.equal(
                  runMemoryPrepareInput({ run, message, projection }).memoryGrantCeiling,
                  expected.get(input.scheduledTaskId!),
                );
                dispatched.push({
                  id: input.scheduledTaskId!,
                  ceiling: run.memoryGrantCeiling ?? "none",
                  bound,
                });
                return {
                  threadId,
                  resumed: false,
                  projection,
                  run,
                  dispatch: dispatchedCommand,
                  message,
                  turnItem: null,
                  delivery: "queued" as const,
                };
              });
            return Layer.mergeAll(
              Layer.mock(Threads.ThreadManagementService)({
                getThreadRecords: () => Effect.succeed(idleThreadProjection(shell)),
                getThreadShell: () => Effect.succeed(shell),
                sendToThread: (input) => dispatch(input.threadId, input, true).pipe(Effect.orDie),
              }),
              Layer.mock(Launch.ThreadLaunchService)({
                launch: (input) =>
                  Effect.gen(function* () {
                    const threadId = ThreadId.make(
                      `task-thread:${input.initialMessage!.scheduledTaskId}`,
                    );
                    yield* createThread(threadId, CommandId.make(`thread:${input.commandId}`));
                    return yield* dispatch(
                      threadId,
                      {
                        ...input.initialMessage!,
                        messageId: input.initialMessage!.messageId!,
                        projectId: input.projectId,
                        threadId,
                        commandId: input.commandId!,
                        mode: "queue",
                        createdBy: input.createdBy ?? "user",
                        creationSource: input.creationSource ?? "web",
                      },
                      false,
                    );
                  }).pipe(Effect.orDie),
              }),
            );
          }),
        ).pipe(Layer.provideMerge(runtime));
        const dependencies = Layer.mergeAll(
          databaseLayer,
          Layer.mock(Git.GitVcsDriver)({
            listWorktreePaths: () => Effect.succeed([project.workspaceRoot]),
          }),
          NodeServices.layer,
          delivery,
          Layer.mock(Scheduler.Scheduler)({
            register: <E, R>(name: string, work: Effect.Effect<void, E, R>) =>
              Effect.gen(function* () {
                if (name !== "scheduled-tasks") return;
                const context = yield* Effect.context<R>();
                due = work.pipe(Effect.provideContext(context), Effect.orDie);
              }),
          }),
          Layer.mock(Secrets.SecretRequests)({}),
          Settings.layerTest({ enableAgentMemoryAccess: !revoked }),
          Layer.mock(Projects.ProjectService)({
            getById: () => Effect.succeed(Option.some(project)),
          }),
          Layer.mock(Providers.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(Adapters.ProviderAdapterRegistryV2)({ list: () => Effect.succeed([]) }),
          Layer.mock(Remote.RemoteDispatchCoordinator)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          Layer.mock(Ssh.SshRemoteDispatch)({}),
        );
        const tasks = Tasks.layer.pipe(Layer.provideMerge(dependencies));
        return Mcp.layer.pipe(Layer.provide(layerNoFleetSync), Layer.provideMerge(tasks));
      };
      // Close both the service and SQL connection before opening the same file again.
      yield* Effect.gen(function* () {
        const mcp = yield* Mcp.OrchestratorMcpService;
        const tasks = yield* Tasks.ScheduledTaskService;
        const sql = yield* SqlClient.SqlClient;
        for (const managed of [false, true]) {
          for (const [scopes, ceiling] of [
            [[], "none"],
            [["memory:read"], "read"],
            [["memory:read", "memory:write"], "read_write"],
          ] as const) {
            // External clients have no current thread to bind; managed callers exercise both paths.
            for (const bound of managed ? [false, true] : [false]) {
              const result = yield* mcp.scheduleTask(caller(managed, scopes), {
                projectId: shell.projectId,
                prompt: "Work",
                schedule: publicInput.schedule,
                bindToCurrentThread: bound,
                clientRequestId: `${managed}-${ceiling}-${bound}`,
              });
              expected.set(result.scheduledTaskId, ceiling);
            }
          }
        }
        for (const [scopes, ceiling] of [
          [[], "none"],
          [["memory:read"], "read"],
          [["memory:read", "memory:write"], "read_write"],
        ] as const) {
          for (const bound of [false, true]) {
            const memoryGrantCeiling = yield* captureRpcMemoryGrantCeiling({
              grantedScopes: scopes,
              readOnly: false,
              reauthorize: caller(false, scopes).reauthorize,
            });
            const { task } = yield* tasks.upsert(
              {
                ...publicInput,
                id: ScheduledTaskId.make(`rpc-${ceiling}-${bound}`),
                threadId: bound ? shell.id : null,
              },
              { memoryGrantCeiling },
            );
            expected.set(task.id, ceiling);
          }
        }
        const id = ScheduledTaskId.make([...expected.keys()][0]!);
        yield* mcp.updateScheduledTask(caller(true, ["memory:read", "memory:write"]), {
          scheduledTaskId: id,
          title: "Restore",
        });
        assert.equal(
          (yield* tasks.list()).tasks.find((t) => t.id === id)?.memoryGrantCeiling,
          "read_write",
        );
        yield* mcp.updateScheduledTask(caller(false, ["memory:read"]), {
          scheduledTaskId: id,
          title: "Lower",
        });
        assert.equal(
          (yield* tasks.list()).tasks.find((t) => t.id === id)?.memoryGrantCeiling,
          "read",
        );
        yield* mcp.updateScheduledTask(caller(false, []), { scheduledTaskId: id, title: "None" });
        const before = (yield* tasks.list()).tasks.find((t) => t.id === id)!;
        for (const [scopes, ceiling] of [
          [["memory:read", "memory:write"], "read_write"],
          [[], "none"],
          [["memory:read"], "read"],
        ] as const) {
          const capture = yield* captureRpcMemoryGrantCeiling({
            grantedScopes: scopes,
            readOnly: false,
            reauthorize: () => Effect.void,
          });
          const changed = yield* tasks.setEnabled(
            { id, enabled: true },
            { memoryGrantCeiling: capture },
          );
          assert.equal(changed.task.memoryGrantCeiling, ceiling);
          assert.equal(changed.task.nextRunAt, before.nextRunAt);
        }
        yield* tasks.setEnabled({ id, enabled: false }, { memoryGrantCeiling: "none" });
        const disabled = yield* tasks.setEnabled(
          { id, enabled: false },
          { memoryGrantCeiling: "read_write" },
        );
        assert.equal(disabled.task.memoryGrantCeiling, "read_write");
        assert.equal(disabled.task.nextRunAt, null);
        yield* tasks.setEnabled({ id, enabled: true }, { memoryGrantCeiling: "read" });
        expected.set(id, "read");
        // Service writes use the separate capture port, ignoring even an untyped forged public object.
        const legacy = yield* tasks.upsert({
          ...publicInput,
          id: ScheduledTaskId.make("legacy"),
          memoryGrantCeiling: "read_write",
        } as ScheduledTaskUpsertInput);
        assert.equal(legacy.task.memoryGrantCeiling, "none");
        expected.set("legacy", "none");
        const updated = yield* tasks.upsert(
          { ...publicInput, id: legacy.task.id },
          { memoryGrantCeiling: "read_write" },
        );
        assert.equal(updated.task.memoryGrantCeiling, "read_write");
        // Reinsert without the authority column, as a migrated legacy row would look.
        yield* sql`DELETE FROM scheduled_tasks WHERE task_id = 'legacy'`;
        yield* sql`INSERT INTO scheduled_tasks ${sql.insert({
          task_id: "legacy",
          title: "Legacy",
          prompt: "Work",
          enabled: 1,
          schedule_json: JSON.stringify(publicInput.schedule),
          project_id: shell.projectId,
          thread_id: null,
          workspace_strategy_json: JSON.stringify(publicInput.workspaceStrategy),
          model_selection_json: JSON.stringify(publicInput.modelSelection),
          runtime_mode: "full-access",
          interaction_mode: "default",
          created_by: "user",
          creation_source: "web",
          created_at: at,
          updated_at: at,
          next_run_at: "2026-10-15T00:01:00.000Z",
          last_run_at: null,
          last_run_status: "never",
          last_run_error: null,
          run_count: 0,
        })}`;
        for (const ceiling of ["none", "read", "read_write"]) {
          assert.isTrue(
            (yield* decodePublicInput({
              ...publicInput,
              memoryGrantCeiling: ceiling,
            }).pipe(Effect.result))._tag === "Failure",
          );
        }
        const settings = yield* Settings.ServerSettingsService;
        let observed = 0;
        const snapshots = yield* tasks.subscribeList().pipe(
          Stream.take(3),
          Stream.tap(() =>
            Effect.gen(function* () {
              observed++;
              if (observed < 3)
                yield* settings.updateSettings({ enableAgentMemoryAccess: observed !== 1 });
            }),
          ),
          Stream.runCollect,
        );
        assert.equal(snapshots.length, 3);
        for (const [index, snapshot] of snapshots.entries()) {
          for (const task of snapshot.tasks) {
            assert.deepEqual(
              task.currentMemoryAccess,
              index === 1
                ? { access: "none", reason: "environment_off" }
                : task.memoryGrantCeiling === "none"
                  ? { access: "none", reason: "ceiling" }
                  : undefined,
            );
          }
        }
        assert.equal(
          (yield* tasks.setEnabled({ id, enabled: true }, { memoryGrantCeiling: "read" })).task
            .currentMemoryAccess?.access,
          undefined,
        );
        revoked = true;
        const failure = yield* mcp
          .updateScheduledTask(caller(false, ["memory:read", "memory:write"]), {
            scheduledTaskId: id,
            title: "Refused",
          })
          .pipe(Effect.result);
        assert.equal(failure._tag, "Failure");
        const createFailure = yield* mcp
          .scheduleTask(caller(false, []), {
            projectId: shell.projectId,
            prompt: "Refused create",
            schedule: publicInput.schedule,
          })
          .pipe(Effect.result);
        assert.equal(createFailure._tag, "Failure");
        const enableFailure = yield* captureRpcMemoryGrantCeiling({
          grantedScopes: ["memory:read", "memory:write"],
          readOnly: false,
          reauthorize: caller(false, ["memory:read", "memory:write"]).reauthorize,
        }).pipe(
          Effect.flatMap((memoryGrantCeiling) =>
            tasks.setEnabled({ id, enabled: true }, { memoryGrantCeiling }),
          ),
          Effect.result,
        );
        assert.equal(enableFailure._tag, "Failure");
        assert.equal((yield* tasks.list()).tasks.find((t) => t.id === id)?.title, "None");
        const rows = yield* sql<{
          task_id: string;
          memory_grant_ceiling: MemoryTaskGrantCeiling;
        }>`SELECT task_id, memory_grant_ceiling FROM scheduled_tasks`;
        assert.deepEqual(new Map(rows.map((r) => [r.task_id, r.memory_grant_ceiling])), expected);
      }).pipe(Effect.provide(phaseLayer()));
      yield* TestClock.setTime(Date.parse(at) + 61_000);
      yield* Effect.gen(function* () {
        const tasks = yield* Tasks.ScheduledTaskService;
        const sql = yield* SqlClient.SqlClient;
        const listed = (yield* tasks.list()).tasks;
        for (const task of listed)
          assert.deepEqual(task.currentMemoryAccess, { access: "none", reason: "environment_off" });
        assert.deepEqual(
          new Map<string, MemoryTaskGrantCeiling>(
            listed.map((t) => [t.id, t.memoryGrantCeiling ?? "none"]),
          ),
          expected,
        );
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("bound-task-thread"),
          threadId: shell.id,
          projectId: shell.projectId,
          title: "Bound",
          modelSelection: shell.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        // No creator live check at firing: all creator fixtures remain revoked.
        yield* due;
        assert.equal(dispatched.length, expected.size);
        assert.equal(dispatched.filter((d) => d.bound).length, 6);
        for (const dispatch of dispatched)
          assert.equal(dispatch.ceiling, expected.get(dispatch.id));
        const rows = yield* sql<{
          run_count: number;
          memory_grant_ceiling: MemoryTaskGrantCeiling;
          task_id: string;
        }>`SELECT task_id, run_count, memory_grant_ceiling FROM scheduled_tasks`;
        for (const row of rows) {
          assert.equal(row.run_count, 1);
          assert.equal(row.memory_grant_ceiling, expected.get(row.task_id));
        }
      }).pipe(Effect.provide(phaseLayer()));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
