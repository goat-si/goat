import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  type OrchestrationV2ServerCommand,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as HostThreadsMcpService from "../../mcp/HostThreadsMcpService.ts";
import * as LaunchWatchService from "../../mcp/LaunchWatchService.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ThreadLaunchMcpService from "../../mcp/ThreadLaunchMcpService.ts";
import { DispatchModeLimit } from "../../orchestration-v2/DispatchModeLimit.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
import { launchActionId, newWorker } from "./goalPlan.ts";
import { testGoal, testSpec } from "./goalTestkit.ts";
import {
  effectiveRuntimeMode,
  GoalWorkerRuntime,
  REMOTE_WORKERS_DISABLED,
  layer as runtimeLayer,
  type OwnerAccess,
  workerThreadId,
} from "./GoalWorkerRuntime.ts";

interface Seen {
  readonly dispatched: Array<{
    readonly command: OrchestrationV2ServerCommand;
    readonly limit: unknown;
  }>;
  readonly launches: Array<{
    readonly modes: unknown;
    readonly threadId: unknown;
    readonly workspace: unknown;
  }>;
  workerMode: RuntimeMode;
  lookup: "found" | "missing" | "error";
}

const ownerAccess = (runtimeMode: RuntimeMode): OwnerAccess => ({
  scope: {
    environmentId: EnvironmentId.make("env:test"),
    capabilities: new Set(["orchestration"] as const),
    issuedAt: 0,
    requestNamespace: "test",
    thread: {
      threadId: ThreadId.make("thread:owner"),
      providerSessionId: "s",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
  },
  runtimeMode,
  canReachHosts: runtimeMode === "full-access",
});

const layerFor = (seen: Seen) =>
  runtimeLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) =>
            seen.lookup === "error"
              ? Effect.fail(new Error("database busy") as never)
              : Effect.succeed(
                  seen.lookup === "missing"
                    ? null
                    : liveThreadShell(threadId, { runtimeMode: seen.workerMode }),
                ),
          assertReviewTaskSendAllowed: () => Effect.void,
          dispatch: (command) =>
            Effect.gen(function* () {
              seen.dispatched.push({ command, limit: yield* DispatchModeLimit });
              return {} as never;
            }),
        }),
        Layer.mock(ThreadLaunchMcpService.ThreadLaunchMcpService)({
          launch: (_scope, input, modes, stable) =>
            Effect.sync(() => {
              seen.launches.push({
                modes,
                threadId: stable?.threadId,
                workspace: input.workspaceStrategy,
              });
              // Goal workers always launch into their stable thread id.
              const threadId = stable?.threadId;
              if (threadId === undefined)
                throw new Error("goal worker launched without a thread id");
              return {
                threadId,
                projectId: input.projectId!,
                modelSelection: input.modelSelection!,
                runId: null,
                status: null,
                watching: false,
                standingInstructionsVersion: null,
              };
            }),
        }),
        Layer.mock(HostThreadsMcpService.HostThreadsMcpService)({}),
        Layer.mock(LaunchWatchService.LaunchWatchService)({}),
        Layer.mock(PullRequestService.PullRequestService)({}),
        Layer.mock(ServerEnvironment.ServerEnvironment)({}),
        Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({}),
      ),
    ),
  );

const makeSeen = (): Seen => ({
  dispatched: [],
  launches: [],
  workerMode: "approval-required",
  lookup: "found",
});

/** The goal asks for approval-required workers; its owner holds full access. */
const careful = testGoal("goal_rt", {
  spec: testSpec({ workers: { ...testSpec().workers, runtimeMode: "approval-required" } }),
});
const worker = {
  ...newWorker(careful, 0, null),
  threadId: ThreadId.make("thread:worker"),
  state: "running" as const,
};

describe("GoalWorkerRuntime", () => {
  it("takes the lowest of the worker mode, the ceiling and the owner's current mode", () => {
    expect(effectiveRuntimeMode({ runtimeMode: "full-access" }, careful)).toBe("approval-required");
    expect(effectiveRuntimeMode({ runtimeMode: "auto-accept-edits" }, testGoal("g"))).toBe(
      "auto-accept-edits",
    );
  });

  it.effect("launches at the lowered mode, under the thread id named by the action", () => {
    const seen = makeSeen();
    return Effect.gen(function* () {
      const runtime = yield* GoalWorkerRuntime;
      const actionId = launchActionId(careful, 0, 1);
      const launched = yield* runtime.launch(ownerAccess("full-access"), {
        goal: careful,
        slot: 0,
        actionId,
        host: null,
        title: "t",
        message: "m",
        branch: "goal/test/s0-a1",
        modelSelection: careful.spec.workers.modelSelection,
      });
      expect(seen.launches).toEqual([
        {
          modes: { runtimeMode: "approval-required", interactionMode: "default" },
          threadId: workerThreadId(actionId),
          workspace: {
            type: "worktree",
            branch: "goal/test/s0-a1",
            baseRef: "dev",
            startFromOrigin: false,
          },
        },
      ]);
      expect(launched.threadId).toBe("fleet-goal:goal:goal_rt:s0:a1:launch");
    }).pipe(Effect.provide(layerFor(seen)));
  });

  it.effect("starts a resumed attempt's worktree from the ref it resumes from", () => {
    const seen = makeSeen();
    return Effect.gen(function* () {
      yield* (yield* GoalWorkerRuntime).launch(ownerAccess("full-access"), {
        goal: careful,
        slot: 0,
        actionId: launchActionId(careful, 0, 2),
        host: null,
        title: "t",
        message: "m",
        branch: "goal/test/s0-a2",
        modelSelection: careful.spec.workers.modelSelection,
        workspace: {
          baseRef: "goat/replica/goal-goal_rt-s0-0123456789ab-1",
          startFromOrigin: false,
        },
      });
      expect(seen.launches.map((launch) => launch.workspace)).toEqual([
        {
          type: "worktree",
          branch: "goal/test/s0-a2",
          baseRef: "goat/replica/goal-goal_rt-s0-0123456789ab-1",
          startFromOrigin: false,
        },
      ]);
    }).pipe(Effect.provide(layerFor(seen)));
  });

  it.effect(
    "refuses a follow-up to a worker above the goal's worker mode, and limits the dispatch",
    () => {
      const seen = makeSeen();
      return Effect.gen(function* () {
        const runtime = yield* GoalWorkerRuntime;
        seen.workerMode = "full-access";
        const refused = yield* runtime
          .followUp(
            ownerAccess("full-access"),
            careful,
            worker,
            "go",
            "goal:goal_rt:s0:a1:run:1:followup",
          )
          .pipe(Effect.flip);
        expect(refused.code).toBe("runtime_mode_escalation_denied");
        expect(seen.dispatched).toEqual([]);
        seen.workerMode = "approval-required";
        yield* runtime.followUp(
          ownerAccess("full-access"),
          careful,
          worker,
          "go",
          "goal:goal_rt:s0:a1:run:1:followup",
        );
        expect(seen.dispatched).toHaveLength(1);
        expect(seen.dispatched[0]!.limit).toEqual({
          runtimeMode: "approval-required",
          interactionMode: "default",
        });
        expect(seen.dispatched[0]!.command).toMatchObject({
          type: "message.dispatch",
          commandId: CommandId.make("goal:goal_rt:s0:a1:run:1:followup"),
        });
      }).pipe(Effect.provide(layerFor(seen)));
    },
  );

  it.effect("tells a missing launch from one it cannot look up", () => {
    const seen = makeSeen();
    return Effect.gen(function* () {
      const runtime = yield* GoalWorkerRuntime;
      const access = ownerAccess("full-access");
      const id = launchActionId(careful, 0, 1);
      expect(yield* runtime.findLaunched(access, careful, id, null)).toMatchObject({
        threadId: workerThreadId(id),
      });
      seen.lookup = "missing";
      expect(yield* runtime.findLaunched(access, careful, id, null)).toBeNull();
      seen.lookup = "error";
      expect((yield* runtime.findLaunched(access, careful, id, null).pipe(Effect.flip)).code).toBe(
        "orchestration_error",
      );
    }).pipe(Effect.provide(layerFor(seen)));
  });
  it.effect("refuses to launch or steer workers on another machine (P1-1, P1-2, P2-5)", () => {
    const seen = makeSeen();
    return Effect.gen(function* () {
      const runtime = yield* GoalWorkerRuntime;
      const launch = yield* runtime
        .launch(ownerAccess("full-access"), {
          goal: careful,
          slot: 0,
          actionId: launchActionId(careful, 0, 1),
          host: "mac-studio",
          title: "t",
          message: "m",
          branch: "goal/test/s0-a1",
          modelSelection: careful.spec.workers.modelSelection,
        })
        .pipe(Effect.flip);
      expect(launch).toMatchObject({ code: "capability_denied", message: REMOTE_WORKERS_DISABLED });
      const followUp = yield* runtime
        .followUp(
          ownerAccess("full-access"),
          careful,
          { ...worker, host: "mac-studio" },
          "go",
          "id",
        )
        .pipe(Effect.flip);
      expect(followUp).toMatchObject({
        code: "capability_denied",
        message: REMOTE_WORKERS_DISABLED,
      });
      expect(seen.launches).toEqual([]);
      expect(seen.dispatched).toEqual([]);
    }).pipe(Effect.provide(layerFor(seen)));
  });
});
