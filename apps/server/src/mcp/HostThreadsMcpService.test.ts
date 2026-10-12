import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as RemoteReportService from "../remoteReports/RemoteReportService.ts";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  type OrchestratorMcpThreadListItem,
  type OrchestratorMcpThreadListResult,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as HostThreadsMcpService from "./HostThreadsMcpService.ts";
import * as LaunchWatchService from "./LaunchWatchService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

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

/** The service over fakes: `hostCall` answers each remote call after running its authorization. */
const runService = <A, E>(
  options: {
    readonly interactionMode: "default" | "plan";
    readonly taskThread?: boolean;
    readonly onResume?: (host: string, id: string) => void;
    readonly hosts?: ReadonlyArray<string>;
    /** The machine the caller was launched from, when it has a report binding. */
    readonly originLabel?: string;
    /** That machine declared at launch that it delivers sends for this one. */
    readonly relaySend?: boolean;
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
      }),
    ),
    Layer.provide(
      Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({
        isTaskThread: () => Effect.succeed(options.taskThread ?? false),
        resume: (host, id) => Effect.sync(() => options.onResume?.(host, id)),
      }),
    ),
    Layer.provide(
      Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
        listThreads: () => Effect.succeed(localList),
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
