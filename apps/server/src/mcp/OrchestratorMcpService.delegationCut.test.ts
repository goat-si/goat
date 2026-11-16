import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderDriverKind,
  type ServerProvider,
  type ThreadId,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { makeHarness } from "../orchestration-v2/testkit/ThreadLaunchHarness.ts";
import { preparationSettled } from "../orchestration-v2/testkit/preparationSettled.ts";
import { modelSelection, projectId } from "../orchestration-v2/testkit/threadLaunchInput.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const providers: ReadonlyArray<ServerProvider> = [
  {
    instanceId: modelSelection.instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-13T00:00:00.000Z",
    models: [{ slug: modelSelection.model, name: "model", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  },
];

it.effect.each(["after the commit", "while the dispatch waits for the parent's lock"] as const)(
  "#3593: a delegation cut %s leaves no child run stuck preparing",
  (cut) =>
    Effect.gen(function* () {
      const lockCase = cut !== "after the commit";
      const dispatching = yield* Deferred.make<void>();
      const committed = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const openWorktree = yield* Deferred.make<void>();
      // Set when the cut lands inside the dispatch after its commit, so the recovery path ran.
      const cutAfterCommit = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const harness = makeHarness({
        providers,
        createWorktree: (input) =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(openWorktree)),
            Effect.as({
              worktree: {
                path: "/repo-worktrees/child",
                refName: input.newRefName,
                headSha: "abc",
              },
            } as never),
          ),
      });
      const gatedThreads = Layer.effect(
        ThreadManagementService.ThreadManagementService,
        Effect.gen(function* () {
          const service = yield* ThreadManagementService.ThreadManagementService;
          return ThreadManagementService.ThreadManagementService.of({
            ...service,
            dispatch: (command) =>
              command.type !== "delegated_task.request"
                ? service.dispatch(command)
                : Deferred.succeed(dispatching, undefined).pipe(
                    Effect.andThen(service.dispatch(command)),
                    Effect.tap(() =>
                      lockCase
                        ? Effect.void
                        : Deferred.succeed(committed, undefined).pipe(
                            Effect.andThen(Deferred.await(resume)),
                            Effect.onInterrupt(() => Deferred.succeed(cutAfterCommit, undefined)),
                          ),
                    ),
                  ),
          });
        }),
      );
      const mcpLayer = OrchestratorMcpService.layer.pipe(
        Layer.provide(layerNoFleetSync),
        Layer.provide(gatedThreads),
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(GitVcsDriver.GitVcsDriver)({
              resolveCommit: () => Effect.succeed({ commitSha: "parent-head" } as never),
            }),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
            Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({}),
            Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({}),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        const parentThreadId = "thread:delegation-cut-parent" as ThreadId;
        yield* threads.dispatch({
          type: "thread.create",
          commandId: CommandId.make("delegation-cut:parent"),
          threadId: parentThreadId,
          projectId,
          title: "Parent",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("delegation-cut:parent-start"),
          threadId: parentThreadId,
          messageId: MessageId.make("delegation-cut:parent-prompt"),
          text: "Delegate",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const parentRun = (yield* threads.getThreadRecords(parentThreadId, ["runs"])).runs[0]!;
        const scope: McpInvocationScope = {
          environmentId: EnvironmentId.make("environment:delegation-cut"),
          requestNamespace: "provider-session:delegation-cut",
          thread: {
            threadId: parentThreadId,
            runId: parentRun.id,
            providerSessionId: "provider-session:delegation-cut",
            providerInstanceId: modelSelection.instanceId,
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(mcpLayer),
        );
        const unlock = yield* Deferred.make<void>();
        if (lockCase) {
          const held = yield* Deferred.make<void>();
          yield* locks
            .withLock(
              parentThreadId,
              Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(unlock))),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(held);
        }
        const delegating = yield* mcp
          .delegateTask(scope, { task: "Work in a worktree", mode: "async", isolation: "worktree" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(lockCase ? dispatching : committed);
        delegating.interruptUnsafe();
        yield* Deferred.succeed(lockCase ? unlock : resume, undefined);
        assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(delegating)));
        const tasks = (yield* threads.getThreadRecords(parentThreadId, ["subagents"])).subagents;
        if (lockCase) {
          // The cut stopped the dispatch before it committed: no task was delegated.
          assert.deepEqual(tasks, []);
          return;
        }
        assert.isTrue(yield* Deferred.isDone(cutAfterCommit));
        const startedInTime = yield* Deferred.await(started).pipe(
          Effect.as(true),
          Effect.timeoutOrElse({ duration: "1 minute", orElse: () => Effect.succeed(false) }),
          Effect.forkChild,
        );
        yield* TestClock.adjust("1 minute");
        assert.isTrue(yield* Fiber.join(startedInTime), "the cut run's preparation never started");
        yield* Deferred.succeed(openWorktree, undefined);
        const child = yield* preparationSettled(tasks[0]!.childThreadId!);
        assert.notInclude(
          child.runs.map((run) => run.status),
          "preparing",
        );
        assert.notInclude(
          child.runs.map((run) => run.status),
          "failed",
        );
      }).pipe(Effect.provide(harness.layer));
    }),
);
