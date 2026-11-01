import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as ThreadResultService from "../threadResults/ThreadResultService.ts";
import * as HostThreadsMcpService from "./HostThreadsMcpService.ts";
import * as LaunchWatchService from "./LaunchWatchService.ts";
import { newLaunchWatch } from "./launchWatch.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as ThreadReplicaService from "./ThreadReplicaService.ts";

const threadId = ThreadId.make("parent");
const parentRunId = RunId.make("parent-run");
const remoteThreadId = ThreadId.make("child-on-host");
const remoteRunId = RunId.make("launched-run-A");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("origin"),
  requestNamespace: "parent-session",
  thread: {
    threadId,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: "parent-session",
  },
  client: undefined,
  issuedAt: 1,
  capabilities: new Set(["orchestration"]),
};

it.effect(
  "thread.read follows saved origin after host attachment changes and unwatch keeps its key",
  () =>
    Effect.gen(function* () {
      const origin = EnvironmentId.make("managed-owner");
      const watch = newLaunchWatch({
        launcherThreadId: threadId,
        host: "box",
        threadId: remoteThreadId,
        sourceEnvironmentId: origin,
        projectId: null,
        title: "Remote",
        incarnation: "watch",
        notifyWebhook: false,
        now: 0,
      });
      const calls: SshRemoteDispatch.SshHostToolCall[] = [];
      const unwatchKeys: Array<{
        launcherThreadId: ThreadId;
        host: string | null | undefined;
        threadId: ThreadId;
      }> = [];
      const remoteRead = {
        thread: {
          threadId: remoteThreadId,
          projectId: "remote-project",
          title: "Remote",
          createdBy: "agent",
          creationSource: "mcp",
          status: "completed",
          latestRunId: remoteRunId,
          activeRunId: null,
          providerInstanceId: "codex",
          model: "gpt-5",
          runtimeMode: "full-access",
          interactionMode: "default",
          linkedPullRequest: null,
          titleRegeneration: null,
          branch: null,
          worktreePath: null,
          parentThreadId: null,
          relationshipToParent: null,
          runCount: 1,
          itemCount: 0,
          pendingRequestCount: 0,
          archived: false,
          settled: false,
          settledAt: null,
          snoozed: false,
          snoozedUntil: null,
          createdAt: "2026-10-12T00:00:00.000Z",
          updatedAt: "2026-10-12T00:00:00.000Z",
        },
        recentRuns: [],
        items: [],
        nextPosition: null,
        hasMore: false,
      };
      const layer = HostThreadsMcpService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({}),
            Layer.mock(ThreadResultService.ThreadResultService)({}),
            Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
              callHostTool: (call, authorize) =>
                Effect.sync(() => {
                  calls.push(call);
                }).pipe(Effect.andThen(authorize), Effect.as(remoteRead)),
            }),
            Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({}),
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadShell: () =>
                Effect.succeed(liveThreadShell(threadId, { activeRunId: parentRunId })),
            }),
            Layer.mock(LaunchWatchService.LaunchWatchService)({
              find: () => Effect.succeed(watch),
              unwatch: (key) =>
                Effect.sync(() => {
                  unwatchKeys.push(key);
                  return true;
                }),
            }),
            Layer.mock(ThreadReplicaService.ThreadReplicaService)({}),
            layerNoFleetSync,
          ),
        ),
      );
      const service = yield* HostThreadsMcpService.HostThreadsMcpService.pipe(
        Effect.provide(layer),
      );
      const read = yield* service.readThread(scope, { host: "box", threadId: remoteThreadId });
      assert.equal(read.thread.threadId, remoteThreadId);
      assert.equal(calls[0]?.environmentId, origin);
      const removed = yield* service.unwatchThread(scope, {
        host: "box",
        threadId: remoteThreadId,
      });
      assert.isTrue(removed.removed);
      assert.deepEqual(unwatchKeys, [
        { launcherThreadId: threadId, host: "box", threadId: remoteThreadId },
      ]);
    }),
);

it.effect("thread.watch saves the environment found by its direct remote read", () =>
  Effect.gen(function* () {
    const origin = EnvironmentId.make("managed-owner");
    const registrations: Array<
      Parameters<LaunchWatchService.LaunchWatchServiceShape["register"]>[0]
    > = [];
    const observed: string[] = [];
    const remoteRead = {
      thread: {
        threadId: remoteThreadId,
        projectId: "remote-project",
        title: "Remote",
        createdBy: "agent",
        creationSource: "mcp",
        status: "completed",
        latestRunId: remoteRunId,
        activeRunId: null,
        providerInstanceId: "codex",
        model: "gpt-5",
        runtimeMode: "full-access",
        interactionMode: "default",
        linkedPullRequest: null,
        titleRegeneration: null,
        branch: null,
        worktreePath: null,
        parentThreadId: null,
        relationshipToParent: null,
        runCount: 1,
        itemCount: 0,
        pendingRequestCount: 0,
        archived: false,
        settled: false,
        settledAt: null,
        snoozed: false,
        snoozedUntil: null,
        createdAt: "2026-10-12T00:00:00.000Z",
        updatedAt: "2026-10-12T00:00:00.000Z",
      },
      recentRuns: [],
      items: [],
      nextPosition: null,
      hasMore: false,
    };
    const layer = HostThreadsMcpService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({}),
          Layer.mock(ThreadResultService.ThreadResultService)({}),
          Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
            callHostTool: (call, authorize) => authorize.pipe(Effect.as(remoteRead)),
            resolveThreadEnvironment: (host, id, authorize) =>
              authorize.pipe(
                Effect.tap(() => Effect.sync(() => observed.push(`${host}:${id}`))),
                Effect.as(origin),
              ),
          }),
          Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({
            isTaskThread: () => Effect.succeed(false),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed(liveThreadShell(threadId, { activeRunId: parentRunId })),
          }),
          Layer.mock(LaunchWatchService.LaunchWatchService)({
            find: () => Effect.succeed(null),
            register: (input) =>
              Effect.sync(() => {
                registrations.push(input);
                return newLaunchWatch({
                  ...input,
                  host: input.host ?? null,
                  incarnation: "direct-watch",
                  notifyWebhook: false,
                  now: 0,
                });
              }),
          }),
          Layer.mock(ThreadReplicaService.ThreadReplicaService)({}),
          layerNoFleetSync,
        ),
      ),
    );
    const service = yield* HostThreadsMcpService.HostThreadsMcpService.pipe(Effect.provide(layer));
    const watched = yield* service.watchThread(scope, { host: "box", threadId: remoteThreadId });
    assert.equal(watched.watch.threadId, remoteThreadId);
    assert.deepEqual(observed, [`box:${remoteThreadId}`]);
    assert.equal(registrations[0]?.sourceEnvironmentId, origin);
  }),
);
