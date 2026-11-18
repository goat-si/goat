import * as Stream from "effect/Stream";
import { GitCommandError } from "@goat/contracts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import { preparationSettled } from "./testkit/preparationSettled.ts";
import {
  encodeThreadProjection,
  adapter,
  claudeModelSelection,
  claudeAdapter,
  makeHarness,
} from "./testkit/ThreadLaunchHarness.ts";
import { launchInput, projectId, modelSelection } from "./testkit/threadLaunchInput.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { CommandId, MessageId, ScheduledTaskId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

it.effect("does not report a scheduled run completed when dispatch is only queued", () => {
  const harness = makeHarness();
  const layerTasks = ScheduledTasks.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        harness.layer,
        NodeCrypto.layer,
        Scheduler.layer,
        Layer.mock(SecretRequests.SecretRequests)({}),
      ),
    ),
  );
  return Effect.gen(function* () {
    const tasks = yield* ScheduledTasks.ScheduledTaskService;
    const { task } = yield* tasks.upsert({
      id: ScheduledTaskId.make("scheduled-task:outcome-regression"),
      title: "Synthetic outcome",
      prompt: "Synthetic scheduled work",
      enabled: false,
      schedule: { type: "interval", everyMs: 60000 },
      projectId,
      threadId: null,
      workspaceStrategy: { type: "root" },
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "user",
      creationSource: "web",
    });
    const result = yield* tasks.runNow({ id: task.id });
    assert.equal(result.task.lastRun?.dispatchStatus, "accepted");
    assert.equal(result.task.lastRun?.threadId, result.threadId);
    assert.isString(result.task.lastRun?.runId);
    assert.notEqual(result.task.lastRunStatus, "succeeded");
    assert.equal(result.task.lastRun?.completedAt, null);
  }).pipe(Effect.provide(Layer.mergeAll(harness.layer, layerTasks)));
});

it.effect.each(
  (["new", "existing"] as const).flatMap((target) =>
    (["user", "agent"] as const).map((createdBy) => ({ target, createdBy })),
  ),
)(
  "attributes $createdBy-configured automations in $target threads without changing their prompt",
  ({ target, createdBy }) => {
    const harness = makeHarness();
    const layerScheduledTasks = ScheduledTasks.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          harness.layer,
          NodeCrypto.layer,
          Scheduler.layer,
          Layer.mock(SecretRequests.SecretRequests)({}),
        ),
      ),
    );
    return Effect.gen(function* () {
      const tasks = yield* ScheduledTasks.ScheduledTaskService;
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const existing =
        target === "existing"
          ? yield* launches.launch(
              launchInput({ command: "command:existing", thread: "thread:existing" }),
            )
          : null;
      const { task } = yield* tasks.upsert({
        id: ScheduledTaskId.make("scheduled-task:attribution"),
        title: "Daily audit",
        prompt: "Audit performance and crashes.",
        enabled: false,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId,
        threadId: existing?.threadId ?? null,
        workspaceStrategy: { type: "root" },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy,
        creationSource: createdBy === "agent" ? "mcp" : "web",
      });
      const result = yield* tasks.runNow({ id: task.id });
      assert.equal(result.task.lastRun?.dispatchStatus, "accepted");
      const projectThreads = yield* threads.listProjectThreads({
        projectId,
        includeSubagents: false,
      });
      const thread =
        projectThreads.find((candidate) => candidate.id === existing?.threadId) ??
        projectThreads[0];
      assert.isDefined(thread);
      assert.equal(result.threadId, thread!.id);
      const projection = yield* threads.getThreadProjection(thread!.id);
      const wire = yield* encodeThreadProjection(projection);
      assert.equal(wire.messages[0]?.text, task.prompt);
      assert.equal(wire.messages[0]?.scheduledTaskId, task.id);
      assert.equal(wire.messages[0]?.createdBy, createdBy);
      const turnItem = wire.turnItems.find(
        (item): item is Extract<typeof item, { type: "user_message" }> =>
          item.type === "user_message",
      );
      assert.equal(turnItem?.text, task.prompt);
      assert.equal(turnItem?.scheduledTaskId, task.id);
    }).pipe(Effect.provide(Layer.mergeAll(harness.layer, layerScheduledTasks)));
  },
);
it.effect(
  "returns no dispatched thread when sending an automation to a missing thread fails",
  () => {
    const harness = makeHarness();
    const layerScheduledTasks = ScheduledTasks.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          harness.layer,
          NodeCrypto.layer,
          Scheduler.layer,
          Layer.mock(SecretRequests.SecretRequests)({}),
        ),
      ),
    );
    return Effect.gen(function* () {
      const tasks = yield* ScheduledTasks.ScheduledTaskService;
      const threadId = ThreadId.make("thread:missing");
      const { task } = yield* tasks.upsert({
        title: "Daily audit",
        prompt: "Audit performance and crashes.",
        enabled: false,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId,
        threadId,
        workspaceStrategy: { type: "root" },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "user",
        creationSource: "web",
      });
      const result = yield* tasks.runNow({ id: task.id });
      assert.equal(result.task.lastRunStatus, "failed");
      assert.isNull(result.threadId);
      assert.equal(result.task.threadId, threadId);
    }).pipe(Effect.provide(Layer.mergeAll(harness.layer, layerScheduledTasks)));
  },
);

it.effect("runs a thread-bound automation on the provider the thread uses now", () => {
  const harness = makeHarness({ adapters: [adapter, claudeAdapter] });
  const layerScheduledTasks = ScheduledTasks.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        harness.layer,
        NodeCrypto.layer,
        Scheduler.layer,
        Layer.mock(SecretRequests.SecretRequests)({}),
      ),
    ),
  );
  return Effect.gen(function* () {
    const tasks = yield* ScheduledTasks.ScheduledTaskService;
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* launches.launch(
      launchInput({ command: "command:switched", thread: "thread:switched" }),
    );
    const { task } = yield* tasks.upsert({
      id: ScheduledTaskId.make("scheduled-task:switched"),
      title: "Hourly check",
      prompt: "Check on the delegated workers.",
      enabled: false,
      schedule: { type: "interval", everyMs: 3_600_000 },
      projectId,
      threadId: launched.threadId,
      workspaceStrategy: { type: "root" },
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    yield* threads.dispatch({
      type: "thread.model-selection.set",
      commandId: CommandId.make("command:switch-selection"),
      threadId: launched.threadId,
      modelSelection: claudeModelSelection,
    });

    const result = yield* tasks.runNow({ id: task.id });
    assert.equal(result.task.lastRun?.dispatchStatus, "accepted");
    const projection = yield* threads.getThreadProjection(launched.threadId);
    const message = projection.messages.find((item) => item.scheduledTaskId === task.id);
    const run = projection.runs.find((item) => item.id === message?.runId);
    assert.deepStrictEqual(run?.modelSelection, claudeModelSelection);
    assert.deepStrictEqual(projection.thread.modelSelection, claudeModelSelection);
  }).pipe(Effect.provide(Layer.mergeAll(harness.layer, layerScheduledTasks)));
});

it.effect("retains automation and sender attribution while a message waits in the queue", () => {
  const harness = makeHarness({ runSetup: () => Effect.never });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* launches.launch(
      launchInput({
        command: "command:automation:queue",
        thread: "thread:automation:queue",
        message: "First message",
        workspace: { type: "worktree", baseRef: "main" },
      }),
    );
    const scheduledTaskId = ScheduledTaskId.make("scheduled-task:queued");
    const senderThreadId = ThreadId.make("thread:agent-sender");
    const queued = yield* threads.sendToThread({
      projectId,
      commandId: CommandId.make("command:automation:queued"),
      threadId: launched.threadId,
      messageId: MessageId.make("message:automation:queued"),
      scheduledTaskId,
      senderThreadId,
      text: "Run the audit",
      attachments: [],
      mode: "queue",
      createdBy: "agent",
      creationSource: "mcp",
    });
    assert.equal(queued.delivery, "queued");
    const projection = yield* threads.getThreadProjection(launched.threadId);
    const message = projection.messages.find((item) => item.id === queued.message.id);
    assert.equal(message?.scheduledTaskId, scheduledTaskId);
    assert.equal(message?.senderThreadId, senderThreadId);
    assert.equal(message?.text, "Run the audit");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("publishes the missing base and its replacement in the scheduled fetch stage", () => {
  const harness = makeHarness({ hasCommit: ({ refName }) => Effect.succeed(refName === "HEAD") });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
    const input = launchInput({
      command: "launch:scheduled-missing-base",
      thread: "thread:scheduled-missing-base",
      message: "Start",
      workspace: { type: "worktree", baseRef: "gone", startFromOrigin: false },
    });
    const launched = yield* launches.launch({
      ...input,
      initialMessage: {
        text: "Start",
        attachments: [],
        scheduledTaskId: ScheduledTaskId.make("task:gone"),
      },
    });
    yield* preparationSettled(launched.threadId);
    const snapshot = yield* tracker.get(launched.threadId);
    assert.deepInclude(
      snapshot?.stages.find((stage) => stage.id === "fetch"),
      {
        detail: "Saved base gone is missing. Using HEAD.",
      },
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("a scheduled preparation retry refuses a replaced checkout before starting setup", () => {
  let setupCalls = 0;
  let replaced = false;
  const harness = makeHarness({
    git: {
      verifyManagedCheckout: ({ projectCwd }) =>
        replaced
          ? Effect.fail(
              new GitCommandError({
                operation: "verifyManagedCheckout",
                command: "git worktree",
                cwd: projectCwd,
                detail: "wrong repository",
              }),
            )
          : Effect.void,
    },
    runSetup: () =>
      Effect.sync(() =>
        ++setupCalls === 1
          ? {
              status: "started" as const,
              terminalId: "test",
              scriptName: "Setup",
              scriptCommand: "false",
              cwd: "/repo-worktrees/feature",
              scriptId: "setup",
              async: false,
              completion: Effect.succeed({ exitCode: 1, durationMs: 0 }),
            }
          : { status: "no-script" as const },
      ),
  });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const initial = launchInput({
      command: "launch:scheduled-replaced",
      thread: "thread:scheduled-replaced",
      message: "Start",
      workspace: { type: "worktree", baseRef: "main", branch: "feature/fixture" },
    });
    const launch = yield* launches.launch({
      ...initial,
      initialMessage: {
        text: "Start",
        attachments: [],
        scheduledTaskId: ScheduledTaskId.make("task:retry"),
      },
    });
    const first = yield* preparationSettled(launch.threadId);
    const run = first.runs[0];
    assert.equal(run?.status, "failed");
    if (run === undefined) return assert.fail("Expected prepared run");
    replaced = true;
    yield* launches.retryPreparation({
      commandId: CommandId.make("launch:scheduled-replaced:retry"),
      threadId: launch.threadId,
      runId: run.id,
    });
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.streamStoredEventsFrom({ threadId: launch.threadId }).pipe(
      Stream.filter(
        (event) =>
          (event.commandId === "launch:scheduled-replaced:retry:fail" ||
            event.commandId === "launch:scheduled-replaced:retry:release") &&
          event.event.type === "run.updated",
      ),
      Stream.runHead,
    );
    const retried = yield* threads.getThreadProjection(launch.threadId);
    assert.equal(retried.runs[0]?.status, "failed");
    assert.equal(harness.runSetup.mock.calls.length, 1);
  }).pipe(Effect.provide(harness.layer));
});

it.effect.each(["first checkout", "retry"] as const)(
  "uses the accepted local commit to reject HEAD drift during $case",
  (scenario) => {
    const retry = scenario === "retry";
    let liveHead = retry ? "initial-local-head" : "advanced-head";
    let baseHead = "initial-local-head";
    let setupCalls = 0;
    const harness = makeHarness({
      git: {
        resolveCommit: () => Effect.succeed({ commitSha: baseHead }),
        verifyManagedCheckout: ({ expectedHead, projectCwd }) =>
          expectedHead !== undefined && expectedHead !== liveHead
            ? Effect.fail(
                new GitCommandError({
                  operation: "verifyManagedCheckout",
                  command: "git worktree",
                  cwd: projectCwd,
                  detail: "checkout HEAD changed",
                }),
              )
            : Effect.void,
      },
      runSetup: () =>
        Effect.sync(() =>
          ++setupCalls === 1 && retry
            ? {
                status: "started" as const,
                terminalId: "test",
                scriptName: "Setup",
                scriptCommand: "false",
                cwd: "/repo-worktrees/feature",
                scriptId: "setup",
                async: false,
                completion: Effect.succeed({ exitCode: 1, durationMs: 0 }),
              }
            : { status: "no-script" as const },
        ),
    });
    return Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const launch = yield* launches.launch(
        launchInput({
          command: "launch:local-pin",
          thread: "thread:local-pin",
          message: "Start",
          workspace: {
            type: "worktree",
            baseRef: "main",
            startFromOrigin: false,
            branch: "feature/fixture",
          },
        }),
      );
      const first = yield* preparationSettled(launch.threadId);
      assert.equal(first.runs[0]?.status, "failed");
      assert.deepInclude(first.runs[0]?.workspacePreparationBasePin, {
        commitSha: "initial-local-head",
        baseRefName: "main",
      });
      if (retry) {
        const run = first.runs[0];
        if (run === undefined) return assert.fail("Expected prepared run");
        liveHead = baseHead = "advanced-head";
        yield* launches.retryPreparation({
          commandId: CommandId.make("launch:local-pin:retry"),
          threadId: launch.threadId,
          runId: run.id,
        });
        const threads = yield* ThreadManagement.ThreadManagementService;
        yield* threads.streamStoredEventsFrom({ threadId: launch.threadId }).pipe(
          Stream.filter(
            (event) =>
              event.event.type === "run.updated" &&
              (event.commandId === "launch:local-pin:retry:fail" ||
                event.commandId === "launch:local-pin:retry:release"),
          ),
          Stream.runHead,
        );
        const result = yield* threads.getThreadProjection(launch.threadId);
        assert.equal(result.runs[0]?.status, "failed");
      }
      assert.equal(harness.runSetup.mock.calls.length, retry ? 1 : 0);
    }).pipe(Effect.provide(harness.layer));
  },
);
