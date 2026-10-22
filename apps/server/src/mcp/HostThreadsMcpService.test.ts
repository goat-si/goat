import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import * as ThreadReplicaService from "./ThreadReplicaService.ts";
import { BUILTIN_PERMISSION_PROFILES } from "@goat/contracts";
import * as FleetSync from "../goatclaw/FleetSync.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as RemoteReportService from "../remoteReports/RemoteReportService.ts";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  type OrchestratorMcpCloudTask,
  type OrchestratorMcpThreadReadResult,
  RunId,
  type OrchestratorMcpThreadListItem,
  type OrchestratorMcpThreadListResult,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as ThreadResultService from "../threadResults/ThreadResultService.ts";
import * as HostThreadsMcpService from "./HostThreadsMcpService.ts";
import type { LaunchWatch } from "./launchWatch.ts";
import * as LaunchWatchService from "./LaunchWatchService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { LAST_ERROR_CHARS, LAST_MESSAGE_EXCERPT_CHARS } from "./threadStatus.ts";

const item = (threadId: string, updatedAt: string, host?: string): OrchestratorMcpThreadListItem =>
  ({
    threadId: ThreadId.make(threadId),
    updatedAt,
    ...(host === undefined ? {} : { host }),
  }) as OrchestratorMcpThreadListItem;

describe("mergeHostThreadLists", () => {
  it("keeps the newest threads across environments and says when more exist", () => {
    const merged = HostThreadsMcpService.mergeHostThreadLists(
      [
        {
          threads: [item("a", "2026-10-11T10:00:00.000Z"), item("b", "2026-10-11T08:00:00.000Z")],
          total: 5,
        },
        {
          threads: [
            item("c", "2026-10-11T09:00:00.000Z", "box"),
            item("d", "2026-10-11T07:00:00.000Z", "box"),
          ],
          total: 2,
        },
      ],
      3,
    );
    expect(merged.threads.map((thread) => thread.threadId)).toEqual(["a", "c", "b"]);
    expect(merged.total).toBe(7);
    expect(merged.truncated).toBe(true);
  });

  it("orders equal times by thread id, then this environment before a host", () => {
    const at = "2026-10-11T10:00:00.000Z";
    const merged = HostThreadsMcpService.mergeHostThreadLists(
      [
        { threads: [item("x", at, "box")], total: 1 },
        { threads: [item("x", at), item("y", at)], total: 2 },
      ],
      10,
    );
    expect(merged.threads.map((thread) => [thread.threadId, thread.host ?? "here"])).toEqual([
      ["y", "here"],
      ["x", "here"],
      ["x", "box"],
    ]);
    expect(merged.truncated).toBe(false);
  });
});

const threadId = ThreadId.make("caller-thread");
const providerInstanceId = ProviderInstanceId.make("codex");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("host-threads-test"),
  requestNamespace: "thread:caller",
  thread: { threadId, providerSessionId: "session", providerInstanceId },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};

const localList: OrchestratorMcpThreadListResult = {
  projectId: null,
  currentThreadId: threadId,
  threads: [item("local-1", "2026-10-11T10:00:00.000Z")],
  nextCursor: null,
  total: 1,
};

const remoteCloudTask: OrchestratorMcpCloudTask = {
  taskId: "host-cloud-task",
  status: "running",
  tracking: "link-only",
  url: "https://example.com/tasks/host",
  localChangesExcluded: true,
  updatedAt: "2026-10-13T01:00:00.000Z",
};

/** The service over fakes: `hostCall` answers each remote call after running its authorization. */
const runService = <A, E>(
  options: {
    readonly interactionMode: "default" | "plan";
    readonly goatclawEnabled?: boolean;
    /** What goatclaw fleet sync reports for the destination; absent leaves the service out. */
    readonly fleetReach?: FleetSync.HostReach;
    readonly onSettle?: (sent: boolean) => void;
    readonly taskThread?: boolean;
    readonly reviewFinished?: boolean | (() => boolean);
    readonly relayReceipt?: {
      readonly clientRequestId: string;
      readonly sequence: number;
      readonly originLabel: string;
    };
    readonly taskOwner?: ThreadId;
    readonly onResume?: (host: string, id: string) => void;
    readonly hosts?: ReadonlyArray<string>;
    /** The machine the caller was launched from, when it has a report binding. */
    readonly originLabel?: string;
    /** That machine declared at launch that it delivers sends for this one. */
    readonly relaySend?: boolean;
    /** The caller's launch watch that find returns. */
    readonly watch?: LaunchWatch;
    readonly localRead?: OrchestratorMcpThreadReadResult;
    readonly onResult?: (id: ThreadId, runId: RunId | null | undefined) => void;
    readonly hostCall: (
      call: SshRemoteDispatch.SshHostToolCall,
    ) => Effect.Effect<unknown, SshRemoteDispatch.SshRemoteDispatchError>;
  },
  body: (service: HostThreadsMcpService.HostThreadsMcpServiceShape) => Effect.Effect<A, E>,
) => {
  const calls: Array<SshRemoteDispatch.SshHostToolCall> = [];
  const relays: Array<unknown> = [];
  const rearms: Array<Parameters<LaunchWatchService.LaunchWatchServiceShape["rearm"]>[0]> = [];
  const layer = HostThreadsMcpService.layer.pipe(
    Layer.provide(
      Layer.mock(ThreadResultService.ThreadResultService)({
        forRun: (id, runId) =>
          Effect.sync(() => {
            options.onResult?.(id, runId);
            return null;
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(RemoteReportService.RemoteReportService)({
        origin: () =>
          Effect.succeed(
            options.originLabel === undefined
              ? null
              : {
                  originLabel: options.originLabel,
                  originThreadId: ThreadId.make("origin"),
                  relaySend: options.relaySend ?? false,
                },
          ),
        relayReceipt: (_threadId, clientRequestId) =>
          Effect.succeed(
            options.relayReceipt?.clientRequestId === clientRequestId
              ? {
                  sequence: options.relayReceipt.sequence,
                  originLabel: options.relayReceipt.originLabel,
                }
              : null,
          ),
        relay: (_threadId, input) =>
          Effect.sync(() => {
            relays.push(input);
            return { sequence: 1 };
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(LaunchWatchService.LaunchWatchService)({
        rearm: (input) => Effect.sync(() => void rearms.push(input)),
        find: () => Effect.succeed(options.watch ?? null),
      }).pipe(Layer.provideMerge(Layer.mock(ThreadReplicaService.ThreadReplicaService)({}))),
    ),
    Layer.provide(
      Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({
        taskOrigin: () => Effect.succeed(options.taskOwner ?? threadId),
        isTaskThread: () => Effect.succeed(options.taskThread ?? false),
        resume: (host, id) => Effect.sync(() => options.onResume?.(host, id)),
      }),
    ),
    Layer.provide(
      Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
        admitRemoteSend: () =>
          Effect.succeed({
            ceiling:
              options.goatclawEnabled === true ? BUILTIN_PERMISSION_PROFILES.worker! : undefined,
            settle: (sent: boolean) => Effect.sync(() => options.onSettle?.(sent)),
          }),
        listThreads: () => Effect.succeed(localList),
        readThread: () =>
          options.localRead === undefined
            ? Effect.die("unused local read")
            : Effect.succeed(options.localRead),
      }),
    ),
    Layer.provide(
      options.fleetReach === undefined
        ? layerNoFleetSync
        : Layer.mock(FleetSync.GoatclawFleetSync)({
            ensure: () => Effect.succeed(options.fleetReach!),
          }),
    ),
    Layer.provide(
      Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
        connectedHosts: Effect.succeed(options.hosts ?? []),
        callHostTool: (call, authorize) => {
          calls.push(call);
          return authorize.pipe(Effect.andThen(options.hostCall(call)));
        },
      }),
    ),
    Layer.provide(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        assertReviewTaskSendAllowed: (input) => {
          if (options.taskOwner !== undefined) expect(input.senderThreadId).toBe(options.taskOwner);
          return (
            typeof options.reviewFinished === "function"
              ? options.reviewFinished()
              : options.reviewFinished
          )
            ? Effect.fail(
                new ThreadManagementService.ThreadManagementReviewTaskFinishedError({
                  threadId: input.threadId,
                }),
              )
            : Effect.void;
        },
        getThreadShell: () =>
          Effect.succeed({
            id: threadId,
            runtimeMode: "full-access",
            interactionMode: options.interactionMode,
            archivedAt: null,
            deletedAt: null,
            activeRunId: "run-1",
            providerInstanceId,
          } as never),
      }),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* HostThreadsMcpService.HostThreadsMcpService;
    const result = yield* body(service).pipe(Effect.result);
    return { result, calls, rearms, relays };
  }).pipe(Effect.provide(layer));
};

const unknownHost = new SshRemoteDispatch.SshRemoteDispatchError({
  reason: "host_unknown",
  message: "juns-macbook-pro is not in this machine's SSH config or known_hosts.",
});

describe("HostThreadsMcpService", () => {
  it.effect("lets a direct host query wait beyond the fan-out deadline", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const returned = yield* Deferred.make<void>();
      const fiber = yield* runService(
        {
          interactionMode: "default",
          hostCall: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({
                projectId: null,
                currentThreadId: null,
                threads: [],
                nextCursor: null,
                total: 2,
              }),
            ),
        },
        (service) => service.listThreads(scope, { host: "slow" }),
      ).pipe(
        Effect.tap(() => Deferred.succeed(returned, undefined)),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust(30_000);
      expect(yield* Deferred.isDone(returned)).toBe(false);
      yield* Deferred.succeed(release, undefined);
      const { result, calls } = yield* Fiber.join(fiber);
      expect(result._tag).toBe("Success");
      if (result._tag !== "Success") return;
      expect(result.success.total).toBe(2);
      expect(result.success.unavailableHosts).toBeUndefined();
      expect(calls[0]?.timeoutMs).toBe(120_000);
    }),
  );

  it.effect("returns fast hosts at the fan-out deadline without interrupting a slow launch", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const returned = yield* Deferred.make<void>();
      const slow = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(Deferred.succeed(finished, undefined)),
        Effect.as({
          projectId: null,
          currentThreadId: null,
          threads: [],
          nextCursor: null,
          total: 99,
        }),
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
      );
      const fiber = yield* runService(
        {
          interactionMode: "default",
          hosts: ["fast", "slow"],
          hostCall: (call) =>
            call.host === "slow"
              ? slow
              : Effect.succeed({
                  projectId: null,
                  currentThreadId: null,
                  threads: [],
                  nextCursor: null,
                  total: 2,
                }),
        },
        (service) => service.listThreads(scope, { allHosts: true }),
      ).pipe(
        Effect.tap(() => Deferred.succeed(returned, undefined)),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust(14_999);
      expect(yield* Deferred.isDone(returned)).toBe(false);
      yield* TestClock.adjust(1);
      const returnedOnTime = yield* Deferred.isDone(returned);
      const wasInterrupted = yield* Deferred.isDone(interrupted);
      // Release even on the old implementation so a failing regression cannot hang.
      yield* Deferred.succeed(release, undefined);
      const { result } = yield* Fiber.join(fiber);
      if (!wasInterrupted) yield* Deferred.await(finished);
      expect(returnedOnTime).toBe(true);
      expect(wasInterrupted).toBe(false);
      expect(result._tag).toBe("Success");
      if (result._tag !== "Success") return;
      expect(result.success.threads.map((thread) => thread.threadId)).toEqual(["local-1"]);
      expect(result.success.total).toBe(3);
      expect(result.success.unavailableHosts).toEqual([
        {
          host: "slow",
          code: "host_unavailable",
          message: expect.stringContaining("host:slow"),
        },
      ]);
      expect(result.success.unavailableHosts?.[0]?.message).toContain("waits longer");
    }),
  );

  it.effect("re-arms only the outside caller's own launcherless watch after its send", () =>
    Effect.gen(function* () {
      const outside: McpInvocationScope = {
        ...scope,
        thread: undefined,
        requestNamespace: "client:bot-a",
      };
      const { result, rearms } = yield* runService(
        {
          interactionMode: "default",
          hostCall: () =>
            Effect.succeed({
              threadId: "remote-1",
              messageId: "message-1",
              runId: "run-9",
              status: "queued",
              delivery: "queued",
            }),
        },
        (service) =>
          service.sendToThread(outside, {
            host: "box",
            threadId: ThreadId.make("remote-1"),
            message: "one more thing",
          }),
      );
      expect(result._tag).toBe("Success");
      // The launch's webhook watch, if it chose one, follows the follow-up run too.
      expect(rearms).toEqual([
        {
          launcherThreadId: null,
          owner: "client:bot-a",
          host: "box",
          threadId: "remote-1",
          runId: "run-9",
        },
      ]);
    }),
  );

  it.effect.each([false, true])(
    "status fallback keeps optional cloud=%s metadata and caller watch",
    (cloud) =>
      Effect.gen(function* () {
        const at = "2026-10-13T01:00:00.000Z";
        const remoteRun = (runId: string, status: string, startedAt: string | null) => ({
          runId,
          ordinal: Number(runId.slice(4)),
          status,
          providerInstanceId: "codex",
          model: "gpt-5",
          requestedAt: at,
          startedAt,
          completedAt: null,
        });
        const { result, calls } = yield* runService(
          {
            interactionMode: "default",
            watch: {
              pendingRuns: ["run-2"],
              reportedRuns: ["run-1"],
              notifyWebhook: false,
              webhookTarget: { type: "named", name: "bot" },
            } as unknown as LaunchWatch,
            hostCall: (call) =>
              call.tool === "goat_thread_status"
                ? Effect.fail(
                    new SshRemoteDispatch.SshRemoteDispatchError({
                      reason: "remote_refused",
                      message: `GOAT on box ${SshRemoteDispatch.REMOTE_THREAD_STATUS_UNSUPPORTED}.`,
                    }),
                  )
                : Effect.succeed({
                    ...(cloud ? { cloudTask: remoteCloudTask } : {}),
                    thread: {
                      threadId: "remote-1",
                      projectId: "remote-project",
                      title: "Fix the flake",
                      createdBy: "agent",
                      creationSource: "mcp",
                      status: "running",
                      latestRunId: "run-3",
                      activeRunId: "run-2",
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
                      runCount: 3,
                      itemCount: 4,
                      pendingRequestCount: 1,
                      archived: false,
                      settled: false,
                      settledAt: null,
                      snoozed: false,
                      snoozedUntil: null,
                      createdAt: at,
                      updatedAt: at,
                    },
                    recentRuns: [
                      remoteRun("run-3", "queued", null),
                      remoteRun("run-2", "running", at),
                    ],
                    items: [],
                    nextPosition: null,
                    hasMore: false,
                  }),
          },
          (service) =>
            service.threadStatus(scope, { host: "box", threadId: ThreadId.make("remote-1") }),
        );
        expect(calls.map((call) => [call.tool, call.writes])).toEqual([
          ["goat_thread_status", false],
          ["goat_thread_read", false],
        ]);
        expect(result._tag === "Success" && result.success).toMatchObject({
          host: "box",
          phase: "waiting",
          terminal: false,
          run: { runId: "run-2", status: "running", startedAt: at },
          queuedRunId: "run-3",
          pendingRequest: { requestId: null, kind: null },
          lastActivityAt: at,
          watch: { pendingRunIds: ["run-2"], lastReportedRunId: "run-1", webhook: true },
        });
        expect(result._tag === "Success" ? result.success.cloudTask : null).toEqual(
          cloud ? remoteCloudTask : undefined,
        );
      }),
  );

  it.effect(
    "returns local replica status when the source is unreachable without exposing contents",
    () =>
      Effect.gen(function* () {
        const watch = {
          pendingRuns: [],
          reportedRuns: [],
          notifyWebhook: false,
          webhookTarget: null,
          title: "Offline work",
          updatedAt: 1000,
          checkpointReplication: "on",
          replica: {
            runId: "copy-run",
            capturedAt: "2026-10-13T01:00:00.000Z",
            bytes: 100,
            sha256: "a".repeat(64),
            contextSha256: "b".repeat(64),
            repositoryKey: "github.com/example/repo",
          },
        } as unknown as LaunchWatch;
        const { result } = yield* runService(
          {
            interactionMode: "default",
            watch,
            hostCall: () =>
              Effect.fail(
                new SshRemoteDispatch.SshRemoteDispatchError({
                  reason: "host_unavailable",
                  message: "offline",
                }),
              ),
          },
          (service) =>
            service.threadStatus(scope, { host: "box", threadId: ThreadId.make("remote") }),
        );
        expect(result._tag).toBe("Success");
        if (result._tag !== "Success") return;
        expect(result.success.remoteUnavailable).toBe(true);
        expect(result.success.terminal).toBe(false);
        expect(result.success.run).toBeNull();
        expect(result.success.replicaStatus?.replica?.runId).toBe("copy-run");
        expect(result.success.replicaStatus?.replica).not.toHaveProperty("bundleBase64");
        expect(result.success.replicaStatus?.replica).not.toHaveProperty("context");
        expect(result.success.replicaStatus?.replica).not.toHaveProperty("file");
      }),
  );

  it.effect("bounds a remote status and names only the next pending run", () =>
    Effect.gen(function* () {
      const at = "2026-10-13T01:00:00.000Z";
      const { result } = yield* runService(
        {
          interactionMode: "default",
          watch: {
            pendingRuns: ["run-2", "run-3", "run-4"],
            reportedRuns: [],
            notifyWebhook: false,
            webhookTarget: null,
          } as unknown as LaunchWatch,
          // A host from before the bounds returns its error whole, and no pendingRunCount.
          hostCall: () =>
            Effect.succeed({
              threadId: "remote-1",
              title: "Fix the flake",
              phase: "failed",
              terminal: true,
              run: null,
              queuedRunId: null,
              pendingRequest: null,
              lastActivityAt: at,
              lastMessage: { role: "assistant", excerpt: "y".repeat(5_000), at },
              lastError: "e".repeat(1_048_576),
              watch: { pendingRunIds: ["a", "b"], lastReportedRunId: null, webhook: false },
              cloudTask: remoteCloudTask,
            }),
        },
        (service) =>
          service.threadStatus(scope, { host: "box", threadId: ThreadId.make("remote-1") }),
      );
      if (result._tag !== "Success") return yield* Effect.die(result);
      expect(result.success.lastError).toHaveLength(LAST_ERROR_CHARS);
      expect(Array.from(result.success.lastMessage?.excerpt ?? "")).toHaveLength(
        LAST_MESSAGE_EXCERPT_CHARS,
      );
      expect(result.success.watch).toEqual({
        pendingRunIds: ["run-2"],
        pendingRunCount: 3,
        lastReportedRunId: null,
        webhook: false,
      });
      expect(result.success.cloudTask).toEqual(remoteCloudTask);
    }),
  );

  it.effect("relays a send to an unreachable host through an origin that declared relaying", () =>
    Effect.gen(function* () {
      const { result, relays, rearms } = yield* runService(
        {
          interactionMode: "default",
          originLabel: "orchestrator-laptop",
          relaySend: true,
          hostCall: () => Effect.fail(unknownHost),
        },
        (service) =>
          service.sendToThread(scope, {
            host: "juns-macbook-pro",
            threadId: ThreadId.make("merge-manager"),
            message: "PR #48 is open.",
            clientRequestId: "pr-48",
          } as never),
      );
      expect(result._tag).toBe("Success");
      if (result._tag !== "Success") return;
      expect(result.success).toEqual({
        host: "juns-macbook-pro",
        threadId: "merge-manager",
        delivery: "relayed",
        via: "orchestrator-laptop",
      });
      expect(relays).toEqual([
        {
          host: "juns-macbook-pro",
          threadId: "merge-manager",
          message: "PR #48 is open.",
          clientRequestId: "pr-48",
        },
      ]);
      expect(rearms).toEqual([]);
    }),
  );

  it.effect.each(["read", "wait", "interrupt"] as const)(
    "keeps the clear error for %s, even through an origin that relays sends",
    (tool) =>
      Effect.gen(function* () {
        const target = { host: "juns-macbook-pro", threadId: ThreadId.make("merge-manager") };
        const { result, relays } = yield* runService(
          {
            interactionMode: "default",
            originLabel: "orchestrator-laptop",
            relaySend: true,
            hostCall: () => Effect.fail(unknownHost),
          },
          (service) =>
            tool === "read"
              ? Effect.asVoid(service.readThread(scope, target as never))
              : tool === "wait"
                ? Effect.asVoid(service.waitForThread(scope, target as never))
                : Effect.asVoid(service.interruptThread(scope, target as never)),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag !== "Failure") return;
        expect(result.failure.message).toContain("started from orchestrator-laptop");
        expect(result.failure.message).toContain("goat_origin_report");
        expect(relays).toEqual([]);
      }),
  );

  it.effect.each([
    ["orchestrator-laptop", true],
    [undefined, false],
  ] as const)(
    "names the launching machine (%s) when a send names a host this one cannot reach",
    ([originLabel, mentionsOrigin]) =>
      Effect.gen(function* () {
        const { result } = yield* runService(
          {
            interactionMode: "default",
            ...(originLabel === undefined ? {} : { originLabel }),
            hostCall: () =>
              Effect.fail(
                new SshRemoteDispatch.SshRemoteDispatchError({
                  reason: "host_unknown",
                  message: "juns-macbook-pro is not in this machine's SSH config or known_hosts.",
                }),
              ),
          },
          (service) =>
            service.sendToThread(scope, {
              host: "juns-macbook-pro",
              threadId: ThreadId.make("merge-manager"),
              message: "PR #48 is open.",
            } as never),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag !== "Failure") return;
        expect(result.failure).toBeInstanceOf(OrchestratorMcpFailure);
        expect(result.failure.code).toBe("invalid_request");
        expect(result.failure.message).toContain("is not in this machine's SSH config");
        if (mentionsOrigin) {
          expect(result.failure.message).toContain("started from orchestrator-laptop");
          expect(result.failure.message).toContain("goat_origin_report");
        } else {
          expect(result.failure.message).not.toContain("goat_origin_report");
        }
      }),
  );

  it.effect("refuses to change a thread on another machine from a plan-mode caller", () =>
    Effect.gen(function* () {
      const sent: string[] = [];
      const { result, rearms } = yield* runService(
        {
          interactionMode: "plan",
          hostCall: (call) => Effect.sync(() => sent.push(call.tool)),
        },
        (service) =>
          service.sendToThread(scope, {
            host: "box",
            threadId: ThreadId.make("remote-1"),
            message: "status?",
          }),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") return;
      expect(result.failure).toBeInstanceOf(OrchestratorMcpFailure);
      expect(result.failure.code).toBe("interaction_mode_escalation_denied");
      expect(sent).toEqual([]);
      // A send that did not happen starts no run to report.
      expect(rearms).toEqual([]);
    }),
  );

  it.effect("sends to another machine without the host argument and tags the result", () =>
    Effect.gen(function* () {
      const { result, calls, rearms } = yield* runService(
        {
          interactionMode: "default",
          hostCall: () =>
            Effect.succeed({
              threadId: "remote-1",
              messageId: "message-1",
              runId: "run-9",
              status: "running",
              delivery: "steered",
            }),
        },
        (service) =>
          service.sendToThread(scope, {
            host: "box",
            threadId: ThreadId.make("remote-1"),
            message: "status?",
          }),
      );
      expect(result._tag === "Success" && result.success.host).toBe("box");
      expect(calls[0]?.tool).toBe("goat_thread_send");
      expect(calls[0]?.writes).toBe(true);
      expect(calls[0]?.arguments).toEqual({ threadId: "remote-1", message: "status?" });
      // The caller's watch on that thread, if any, follows the run the send joined.
      expect(rearms).toEqual([
        { launcherThreadId: threadId, host: "box", threadId: "remote-1", runId: "run-9" },
      ]);
    }),
  );

  it.effect("lists every project on another machine when no projectId is passed", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* runService(
        {
          interactionMode: "plan",
          hostCall: () =>
            Effect.succeed({
              projectId: null,
              currentThreadId: null,
              threads: [],
              nextCursor: null,
              total: 0,
            }),
        },
        (service) => service.listThreads(scope, { host: "box" }),
      );
      expect(result._tag === "Success" && result.success.host).toBe("box");
      expect(calls[0]?.arguments).toEqual({ allProjects: true });
      expect(calls[0]?.writes).toBe(false);
    }),
  );

  it.effect("lists every connected host and reports the unreachable one", () =>
    Effect.gen(function* () {
      const { result } = yield* runService(
        {
          interactionMode: "default",
          hosts: ["box", "gone"],
          hostCall: (call) =>
            call.host === "gone"
              ? Effect.fail(
                  new SshRemoteDispatch.SshRemoteDispatchError({
                    reason: "host_unavailable",
                    message: "gone is unavailable",
                  }),
                )
              : Effect.succeed({
                  projectId: null,
                  currentThreadId: null,
                  threads: [
                    {
                      ...item("remote-1", "2026-10-11T11:00:00.000Z"),
                      projectId: "project-r",
                      title: "Remote",
                      createdBy: "user",
                      creationSource: "web",
                      status: "idle",
                      latestRunId: null,
                      providerInstanceId: "codex",
                      model: "gpt",
                      runtimeMode: "full-access",
                      interactionMode: "default",
                      linkedPullRequest: null,
                      settled: false,
                      settledAt: null,
                      snoozed: false,
                      snoozedUntil: null,
                      parentThreadId: null,
                      relationshipToParent: null,
                      itemCount: 1,
                      createdAt: "2026-10-11T11:00:00.000Z",
                    },
                  ],
                  nextCursor: null,
                  total: 1,
                }),
        },
        (service) => service.listThreads(scope, { allHosts: true, limit: 10 }),
      );
      expect(result._tag).toBe("Success");
      if (result._tag !== "Success") return;
      expect(result.success.threads.map((thread) => [thread.threadId, thread.host])).toEqual([
        ["remote-1", "box"],
        ["local-1", undefined],
      ]);
      expect(result.success.unavailableHosts).toEqual([
        { host: "gone", code: "host_unavailable", message: "gone is unavailable" },
      ]);
      expect(result.success.total).toBe(2);
      expect(result.success.nextCursor).toBeNull();
    }),
  );

  it.effect("refuses a cursor with allHosts", () =>
    Effect.gen(function* () {
      const { result } = yield* runService(
        { interactionMode: "default", hostCall: () => Effect.succeed(null) },
        (service) => service.listThreads(scope, { allHosts: true, cursor: 50 }),
      );
      expect(result._tag === "Failure" && result.failure.code).toBe("invalid_request");
    }),
  );
});

it.effect("successful remote send resumes the same host and thread", () =>
  Effect.gen(function* () {
    const resumed: Array<[string, string]> = [];
    const { result } = yield* runService(
      {
        interactionMode: "default",
        onResume: (host, id) => {
          resumed.push([host, id]);
        },
        hostCall: () =>
          Effect.succeed({
            host: "box",
            threadId: "remote",
            messageId: "message",
            runId: "run-a",
            status: "running",
            delivery: "started",
          }),
      },
      (service) =>
        service.sendToThread(scope, {
          host: "box",
          threadId: ThreadId.make("remote"),
          message: "continue",
        }),
    );
    expect(result._tag).toBe("Success");
    expect(resumed).toEqual([["box", "remote"]]);
  }),
);

it.effect("refuses a launch watch for a remote delegated task", () =>
  runService(
    {
      interactionMode: "default",
      taskThread: true,
      hostCall: () => Effect.die("Must not read the remote"),
    },
    (service) =>
      Effect.gen(function* () {
        const result = yield* service
          .watchThread(scope, { host: "box", threadId: ThreadId.make("remote-task") })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.code).toBe("invalid_request");
          expect(result.failure.message).toContain("task_status");
        }
      }),
  ),
);

it.effect.each([true, false])("decodes remote wait with question IDs present=%s", (present) =>
  Effect.gen(function* () {
    const { result, calls } = yield* runService(
      {
        interactionMode: "default",
        hostCall: () =>
          Effect.succeed({
            threadId: "remote-1",
            runId: "run-1",
            status: "completed",
            timedOut: false,
            ...(present ? { pendingRequestIds: ["q-1"] } : {}),
          }),
      },
      (service) =>
        service.waitForThread(scope, {
          host: "box",
          threadId: ThreadId.make("remote-1"),
          ...(present ? { ignoreRequestIds: [RuntimeRequestId.make("forwarded")] } : {}),
        }),
    );
    expect(result).toMatchObject({ success: { host: "box", timedOut: false } });
    if (result._tag === "Success")
      expect(result.success.pendingRequestIds).toEqual(present ? ["q-1"] : undefined);
    expect(calls[0]?.arguments).not.toHaveProperty("host");
    if (present) expect(calls[0]?.arguments.ignoreRequestIds).toEqual(["forwarded"]);
    else expect(calls[0]?.arguments).not.toHaveProperty("ignoreRequestIds");
    expect(calls[0]?.writes).toBe(false);
  }),
);

it.effect(
  "local read enriches the result once inside the host service and retains cloud metadata",
  () =>
    Effect.gen(function* () {
      const runId = RunId.make("run:local-cloud-result");
      const read = {
        thread: { latestRunId: runId },
        cloudTask: remoteCloudTask,
        recentRuns: [],
        items: [],
        nextPosition: null,
        hasMore: false,
      } as unknown as OrchestratorMcpThreadReadResult;
      const enriched: ReadonlyArray<ThreadId | RunId | null | undefined>[] = [];
      const { result, calls } = yield* runService(
        {
          interactionMode: "default",
          localRead: read,
          onResult: (id, run) => enriched.push([id, run]),
          hostCall: () => Effect.die("a local read must not reach SSH"),
        },
        (service) => service.readThread(scope, { threadId }),
      );
      expect(result._tag).toBe("Success");
      if (result._tag === "Success") expect(result.success).toEqual({ ...read, result: null });
      expect(enriched).toEqual([[threadId, runId]]);
      expect(calls).toEqual([]);
    }),
);

it.effect("refuses a finished remote review before forwarding or relaying", () =>
  Effect.gen(function* () {
    const { result, calls, relays } = yield* runService(
      {
        interactionMode: "default",
        reviewFinished: true,
        taskOwner: ThreadId.make("another-review-owner"),
        relaySend: true,
        originLabel: "origin",
        hostCall: () => Effect.die("A finished review cannot be forwarded"),
      },
      (service) =>
        service.sendToThread(scope, {
          host: "box",
          threadId: ThreadId.make("finished-review"),
          message: "Review again",
        }),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    expect(result.failure).toMatchObject({ code: "thread_not_sendable" });
    expect(result.failure.message).toContain("delegate_task");
    expect(calls).toHaveLength(0);
    expect(relays).toHaveLength(0);
  }),
);

it.effect("reuses a successful remote send before the finished-review precheck on retry", () =>
  Effect.gen(function* () {
    let finished = false;
    const target = ThreadId.make("review-retry");
    const delivered = {
      threadId: target,
      messageId: "sent-review-message",
      runId: "review-run",
      status: "running",
      delivery: "steered",
    };
    const { result, calls } = yield* runService(
      {
        interactionMode: "default",
        reviewFinished: () => finished,
        hostCall: () => Effect.succeed(delivered),
      },
      (service) =>
        Effect.gen(function* () {
          const input = {
            host: "box",
            threadId: target,
            message: "Steer once",
            clientRequestId: "lost-response",
          };
          const first = yield* service.sendToThread(scope, input);
          finished = true;
          expect(yield* service.sendToThread(scope, input)).toEqual(first);
          const refused = yield* service
            .sendToThread(scope, { ...input, clientRequestId: "new-request" })
            .pipe(Effect.result);
          expect(refused._tag).toBe("Failure");
          if (refused._tag === "Failure") expect(refused.failure.code).toBe("thread_not_sendable");
        }),
    );
    expect(result._tag).toBe("Success");
    expect(calls).toHaveLength(1);
  }),
);

it.effect("a cold cache reads a durable relay receipt before the finished-review guard", () =>
  Effect.gen(function* () {
    const target = ThreadId.make("review-durable-retry");
    const { result, calls, relays } = yield* runService(
      {
        interactionMode: "default",
        reviewFinished: true,
        relayReceipt: { clientRequestId: "persisted-relay", sequence: 7, originLabel: "launcher" },
        hostCall: () => Effect.die("A recorded handoff must not reach SSH"),
      },
      (service) =>
        Effect.gen(function* () {
          const input = {
            host: "box",
            threadId: target,
            message: "Already handed off",
            clientRequestId: "persisted-relay",
          };
          expect(yield* service.sendToThread(scope, input)).toEqual({
            host: "box",
            threadId: target,
            delivery: "relayed",
            via: "launcher",
          });
          const refused = yield* service
            .sendToThread(scope, { ...input, clientRequestId: "new-request" })
            .pipe(Effect.result);
          expect(refused._tag).toBe("Failure");
          if (refused._tag === "Failure") expect(refused.failure.code).toBe("thread_not_sendable");
        }),
    );
    expect(result._tag).toBe("Success");
    expect(calls).toHaveLength(0);
    expect(relays).toHaveLength(0);
  }),
);

it.effect("forwards ready-only reads without changing ordinary host bootstrap policy", () =>
  runService(
    {
      interactionMode: "default",
      hostCall: () => Effect.succeed({ checkedBy: "server", diagnoses: [] }),
    },
    (service) =>
      Effect.gen(function* () {
        const decode = (value: unknown) => Effect.succeed({ value });
        yield* service.readOnHost(
          scope,
          { host: "box", tool: "goat_provider_diagnose", arguments: {}, requireReady: true },
          decode,
        );
        yield* service.readOnHost(
          scope,
          { host: "box", tool: "goat_project_list", arguments: {} },
          decode,
        );
      }),
  ).pipe(
    Effect.tap(({ calls }) =>
      Effect.sync(() => {
        expect(calls[0]?.requireReady).toBe(true);
        expect(calls[1]?.requireReady).toBeUndefined();
      }),
    ),
    Effect.asVoid,
  ),
);

it.effect("forwards the caller's goatclaw ceiling with a remote send and keeps its lane", () =>
  Effect.gen(function* () {
    const settled: Array<boolean> = [];
    const { result, calls } = yield* runService(
      {
        interactionMode: "default",
        goatclawEnabled: true,
        fleetReach: { sync: { state: "applied" }, enforcesCeilings: true },
        onSettle: (sent) => settled.push(sent),
        hostCall: () =>
          Effect.succeed({
            threadId: "remote",
            messageId: "message-1",
            runId: "run-1",
            status: "running",
            delivery: "steered",
          }),
      },
      (service) =>
        service.sendToThread(scope, {
          host: "box",
          threadId: ThreadId.make("remote"),
          message: "Continue",
        }),
    );
    expect(result._tag).toBe("Success");
    expect(calls[0]?.tool).toBe("goat_thread_send");
    expect(calls[0]?.arguments.permissionProfileCeiling).toEqual(
      BUILTIN_PERMISSION_PROFILES.worker,
    );
    expect(settled).toEqual([true]);
  }),
);

it.effect("refuses a profiled remote send to a GOAT too old to enforce its ceiling", () =>
  Effect.gen(function* () {
    const settled: Array<boolean> = [];
    for (const fleetReach of [
      { sync: { state: "outdated" as const }, enforcesCeilings: false },
      { sync: { state: "pending" as const, message: "box is offline." }, enforcesCeilings: false },
      undefined,
    ]) {
      const { result, calls } = yield* runService(
        {
          interactionMode: "default",
          goatclawEnabled: true,
          ...(fleetReach === undefined ? {} : { fleetReach }),
          onSettle: (sent) => settled.push(sent),
          hostCall: () => Effect.die("Remote send must be refused"),
        },
        (service) =>
          service.sendToThread(scope, {
            host: "box",
            threadId: ThreadId.make("remote"),
            message: "Continue",
          }),
      );
      expect(result).toMatchObject({ _tag: "Failure", failure: { code: "capability_denied" } });
      expect(calls).toHaveLength(0);
    }
    expect(settled).toEqual([false, false, false]);
  }),
);
