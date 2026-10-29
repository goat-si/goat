import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, ScheduledTaskId, ThreadId } from "@goat/contracts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import {
  layerCheckpointStoreTest,
  layerGitWorkflowTest,
  layerPlatformTest,
  layerServerConfig,
  layerTestProviderInstanceRegistry,
  modelSelection,
} from "./runtimeLayer.testkit.ts";

const layerScheduledTasksTest = ScheduledTaskService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Scheduler.layer,
    ),
  ),
);

const layerResourceCleanupTest = ResourceCleanupService.layer.pipe(
  Layer.provideMerge(layerScheduledTasksTest),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(PreviewManager.PreviewManager)({ close: () => Effect.void }),
      Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
    ),
  ),
);

const layerProjectDeletionTest = Layer.mergeAll(
  RuntimeLayer.layer.pipe(Layer.provide(RuntimeLayer.layerProjectService)),
  RuntimeLayer.layerProjectService,
  RuntimeLayer.layerEventSink,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provide(
    Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
    }),
  ),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provideMerge(layerResourceCleanupTest),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerPlatformTest),
);

it.layer(layerProjectDeletionTest)("project deletion during thread commands", (it) => {
  it.effect.each(["thread", "project"] as const)(
    "deleting a %s removes its thread-bound automations through the effect worker",
    (deletion) =>
      Effect.gen(function* () {
        const projects = yield* ProjectService.ProjectService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const tasks = yield* ScheduledTaskService.ScheduledTaskService;
        const projectId = ProjectId.make(`automation-delete-project:${deletion}`);
        const threadId = ThreadId.make(`automation-delete-thread:${deletion}`);
        const otherThreadId = ThreadId.make(`automation-surviving-thread:${deletion}`);
        yield* projects.create({
          commandId: CommandId.make(`automation-create-project:${deletion}`),
          projectId,
          title: "Automation lifecycle",
          workspaceRoot: `/work/automation-lifecycle/${deletion}`,
        });
        for (const id of [threadId, otherThreadId]) {
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`automation-create:${id}`),
            createdBy: "user",
            creationSource: "web",
            threadId: id,
            projectId: id === threadId ? projectId : ProjectId.make("automation-other-project"),
            title: "Automation target",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
        }
        const save = (name: string, target: ThreadId | null, webhook = false) =>
          tasks.upsert({
            id: ScheduledTaskId.make(`automation:${deletion}:${name}`),
            title: name,
            prompt: "Check orchestration progress",
            enabled: !webhook,
            schedule: webhook ? { type: "webhook" } : { type: "interval", everyMs: 60_000 },
            projectId,
            threadId: target,
            workspaceStrategy: { type: "root" },
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            createdBy: "agent",
            creationSource: "mcp",
          });
        const { task: bound } = yield* save("bound", threadId);
        const { task: webhook } = yield* save("webhook", threadId, true);
        const { task: independent } = yield* save("independent", null);
        yield* save("detached", threadId);
        const { task: detached } = yield* save("detached", null);
        yield* save("moved", threadId);
        const { task: moved } = yield* save("moved", otherThreadId);
        const { task: other } = yield* save("other", otherThreadId);
        yield* tasks.triggerWebhook({
          hookId: webhook.id,
          token: webhook.webhook!.path.split("/").at(-1)!,
          method: "POST",
          path: webhook.webhook!.path,
          query: "",
          headers: {},
          body: new Uint8Array(),
          bodyText: "",
        });
        assert.lengthOf((yield* tasks.listWebhookDeliveries({ id: webhook.id })).deliveries, 1);

        yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make(`automation-archive:${deletion}`),
          threadId,
        });
        yield* worker.drain();
        assert.include(
          (yield* tasks.list()).tasks.map((task) => task.id),
          bound.id,
        );

        if (deletion === "thread") {
          yield* orchestrator.dispatch({
            type: "thread.delete",
            commandId: CommandId.make(`automation-delete:${deletion}`),
            threadId,
          });
        } else {
          yield* projects.delete({
            commandId: CommandId.make(`automation-delete:${deletion}`),
            projectId,
            force: true,
          });
        }
        yield* worker.drain();
        const remainingIds = (yield* tasks.list()).tasks.map((task) => task.id);
        assert.notInclude(remainingIds, bound.id);
        assert.notInclude(remainingIds, webhook.id);
        assert.includeMembers(remainingIds, [independent.id, detached.id, moved.id, other.id]);
        assert.lengthOf((yield* tasks.listWebhookDeliveries({ id: webhook.id })).deliveries, 0);
        const rejected = yield* tasks.runNow({ id: bound.id }).pipe(Effect.flip);
        assert.equal(rejected.message, "Schedule task not found.");
        assert.equal(
          (yield* tasks.triggerWebhook({
            hookId: webhook.id,
            token: webhook.webhook!.path.split("/").at(-1)!,
            method: "POST",
            path: webhook.webhook!.path,
            query: "",
            headers: {},
            body: new Uint8Array(),
            bodyText: "",
          }))._tag,
          "not_found",
        );
        // Retried cleanup is harmless and cannot affect unrelated tasks.
        yield* tasks.deleteForThread(threadId);
        assert.sameMembers(
          (yield* tasks.list()).tasks.map((task) => task.id),
          remainingIds,
        );
      }),
  );
  it.effect("waits for an in-flight thread update before planning deletion", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const projectId = ProjectId.make("runtime-project-delete-concurrent");
      const threadId = ThreadId.make("runtime-thread-delete-concurrent");
      const updateCommandId = CommandId.make("runtime-thread-delete-concurrent-update");
      yield* projects.create({
        commandId: CommandId.make("runtime-project-delete-concurrent-create"),
        projectId,
        title: "Concurrent deletion",
        workspaceRoot: "/work/concurrent-deletion",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("runtime-thread-delete-concurrent-create"),
        createdBy: "user",
        creationSource: "web",
        threadId,
        projectId,
        title: "Original title",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });

      const updateReady = yield* Deferred.make<void>();
      const releaseUpdate = yield* Deferred.make<void>();
      const deletionQueued = yield* Deferred.make<void>();
      const commitCommand = eventSink.commitCommand;
      const withLock = executor.withLock;
      let threadLockRequests = 0;
      const commitSpy = vi
        .spyOn(eventSink, "commitCommand")
        .mockImplementation((input) =>
          input.commandId === updateCommandId
            ? Deferred.succeed(updateReady, undefined).pipe(
                Effect.andThen(Deferred.await(releaseUpdate)),
                Effect.andThen(commitCommand(input)),
              )
            : commitCommand(input),
        );
      const observeLock: ThreadCommandExecutor.ThreadCommandExecutor["Service"]["withLock"] = (
        key,
        effect,
      ) => {
        if (key !== threadId || ++threadLockRequests !== 2) return withLock(key, effect);
        return Deferred.succeed(deletionQueued, undefined).pipe(
          Effect.andThen(withLock(key, effect)),
        );
      };
      const lockSpy = vi.spyOn(executor, "withLock").mockImplementation(observeLock);
      yield* Effect.gen(function* () {
        const updateFiber = yield* orchestrator
          .dispatch({
            type: "thread.metadata.update",
            commandId: updateCommandId,
            threadId,
            title: "Updated before deletion",
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.raceFirst(
          Deferred.await(updateReady),
          Fiber.join(updateFiber).pipe(
            Effect.andThen(Effect.die("The update completed before reaching its commit barrier.")),
          ),
        );
        const deleteFiber = yield* projects
          .delete({
            commandId: CommandId.make("runtime-project-delete-concurrent-delete"),
            projectId,
            force: true,
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.raceFirst(
          Deferred.await(deletionQueued),
          Fiber.join(deleteFiber).pipe(
            Effect.andThen(Effect.die("Project deletion bypassed the in-flight thread command.")),
          ),
        );
        yield* Deferred.succeed(releaseUpdate, undefined);
        yield* Fiber.join(updateFiber);
        const deletedProject = yield* Fiber.join(deleteFiber);
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.isNotNull(deletedProject.deletedAt);
        assert.isNotNull(projection.thread.deletedAt);
        assert.equal(projection.thread.title, "Updated before deletion");
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            commitSpy.mockRestore();
            lockSpy.mockRestore();
          }),
        ),
      );
    }),
  );
});
