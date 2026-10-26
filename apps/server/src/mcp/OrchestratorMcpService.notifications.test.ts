import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { CommandId, EventId, EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { makeHarness } from "../orchestration-v2/testkit/ThreadLaunchHarness.ts";
import { projectId } from "../orchestration-v2/testkit/threadLaunchInput.ts";
import * as Tasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Secrets from "../secrets/SecretRequests.ts";
import * as RemoteDispatch from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as Ssh from "../sshRemote/SshRemoteDispatch.ts";
import * as Mcp from "./OrchestratorMcpService.ts";
import { layerOrchestratorService } from "./OrchestratorMcpService.testkit.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

it.effect(
  "roundtrips policies through real MCP schedule services, preserves future values and rejects read-only writes",
  () => {
    const harness = makeHarness();
    const dependencies = Layer.mergeAll(
      harness.layer,
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(Secrets.SecretRequests)({}),
    );
    const tasks = Tasks.layer.pipe(Layer.provide(dependencies));
    const mcp = layerOrchestratorService.pipe(
      Layer.provide(
        Layer.mergeAll(
          dependencies,
          tasks,
          Layer.mock(RemoteDispatch.RemoteDispatchCoordinator)({}),
          Layer.mock(Ssh.SshRemoteDispatch)({}),
        ),
      ),
    );
    const scope: McpInvocationScope = {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "client:notifications",
      thread: undefined,
      client: { sessionId: "notifications", label: "Synthetic", access: "full-access" },
      capabilities: new Set(["orchestration"]),
      issuedAt: 0,
    };
    return Effect.gen(function* () {
      const service = yield* Mcp.OrchestratorMcpService;
      const sql = yield* SqlClient.SqlClient;
      const created = yield* service.scheduleTask(scope, {
        projectId,
        prompt: "Synthetic",
        schedule: { type: "interval", everyMs: 60000 },
        enabled: false,
        bindToCurrentThread: false,
        notificationPolicy: "failed_runs_only",
      });
      assert.equal(created.notificationPolicy, "failed_runs_only");
      const updated = yield* service.updateScheduledTask(scope, {
        scheduledTaskId: created.scheduledTaskId,
        title: "Edited",
      });
      assert.equal(updated.notificationPolicy, "failed_runs_only");
      yield* sql`UPDATE scheduled_tasks SET notification_policy='future' WHERE task_id=${created.scheduledTaskId}`;
      assert.equal(
        (yield* service.updateScheduledTask(scope, {
          scheduledTaskId: created.scheduledTaskId,
          title: "Keep future",
        })).notificationPolicy,
        "future",
      );
      assert.equal(
        (yield* service.listScheduledTasks(scope, { projectId })).tasks[0]?.notificationPolicy,
        "future",
      );
      yield* Effect.flip(
        service.updateScheduledTask(scope, {
          scheduledTaskId: created.scheduledTaskId,
          notificationPolicy: "important_updates",
        }),
      );
      const denied = yield* Effect.flip(
        service.updateScheduledTask(
          { ...scope, client: { sessionId: "readonly", label: "Synthetic", access: "read-only" } },
          { scheduledTaskId: created.scheduledTaskId, notificationPolicy: "all_runs" },
        ),
      );
      assert.equal(denied.code, "runtime_mode_escalation_denied");
      yield* service.updateScheduledTask(scope, {
        scheduledTaskId: created.scheduledTaskId,
        notificationPolicy: "failed_runs_only",
      });
      const scheduler = yield* Tasks.ScheduledTaskService;
      const current = (yield* scheduler.list()).tasks[0]!;
      yield* scheduler.upsert({
        ...current,
        schedule: { type: "interval", everyMs: 60000 },
        notificationPolicy: "failed_runs_only",
        workspaceStrategy: { type: "root" },
      });
      const fired = yield* scheduler.runNow({ id: current.id });
      const threads = yield* Threads.ThreadManagementService;
      const sink = yield* EventSink.EventSinkV2;
      const run = (yield* threads.getThreadProjection(fired.threadId!)).runs[0]!;
      const at = yield* DateTime.now;
      const event = {
        id: EventId.make("mcp-failure"),
        type: "run.updated" as const,
        threadId: run.threadId,
        occurredAt: at,
        payload: { ...run, status: "failed" as const, completedAt: at },
      };
      yield* sink.write({ events: [event] });
      yield* threads.dispatch({
        type: "thread.mark-unread",
        commandId: CommandId.make("mcp-mark-unread"),
        threadId: run.threadId,
      });
      const later = DateTime.add(at, { seconds: 1 });
      yield* sink.write({
        events: [
          {
            ...event,
            id: EventId.make("mcp-reopen"),
            payload: { ...run, status: "preparing", completedAt: null },
          },
          {
            ...event,
            id: EventId.make("mcp-quiet"),
            payload: { ...run, status: "completed", completedAt: later },
          },
        ],
      });
      assert.isTrue((yield* service.readThread(scope, { threadId: run.threadId })).thread.unread);
      yield* threads.dispatch({
        type: "thread.visit",
        commandId: CommandId.make("mcp-visit"),
        threadId: run.threadId,
        visitedAt: DateTime.formatIso(later),
      });
      assert.isFalse((yield* service.readThread(scope, { threadId: run.threadId })).thread.unread);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          mcp,
          harness.layer,
          tasks,
          RuntimeLayer.layerEventSink.pipe(Layer.provide(harness.layer)),
        ),
      ),
    );
  },
);
