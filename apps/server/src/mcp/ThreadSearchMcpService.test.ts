import * as ThreadReplicaService from "./ThreadReplicaService.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestratorMcpThreadSearchInput,
  type OrchestratorMcpThreadSearchMatch,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as ThreadResultService from "../threadResults/ThreadResultService.ts";
import * as HostThreads from "./HostThreadsMcpService.ts";
import * as LaunchWatchService from "./LaunchWatchService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as ThreadSearchMcp from "./ThreadSearchMcpService.ts";

const callerId = ThreadId.make("caller");
const project = ProjectId.make("project:mcp-test");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("origin"),
  requestNamespace: "caller",
  issuedAt: 0,
  thread: {
    threadId: callerId,
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
};
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 1, 0, minute));

const localThread = (id: string, minute: number, status: "idle" | "completed" = "completed") => ({
  ...liveThreadShell(ThreadId.make(id), { activeRunId: null }),
  title: `Local ${id}`,
  status,
  updatedAt: at(minute),
});

const remoteMatch = (id: string, minute: number): OrchestratorMcpThreadSearchMatch => ({
  threadId: ThreadId.make(id),
  projectId: ProjectId.make("project:remote"),
  projectTitle: "remote",
  title: `Remote ${id}`,
  status: "completed",
  updatedAt: DateTime.formatIso(at(minute)),
  archived: false,
  source: "user",
  snippet: "modelflare",
  messageCreatedAt: null,
});

/** A host whose own goat_thread_search pages its threads by offset, as this server does. */
const pagingHost =
  (matches: ReadonlyArray<OrchestratorMcpThreadSearchMatch>) =>
  (call: SshRemoteDispatch.SshHostToolCall) => {
    const offset = Number(call.arguments.cursor ?? 0);
    const limit = Number(call.arguments.limit);
    const page = matches.slice(offset, offset + limit);
    const end = offset + page.length;
    return Effect.succeed({
      matches: page,
      nextCursor: end < matches.length ? String(end) : null,
      truncated: false,
    });
  };

const runSearch = (
  options: {
    readonly local?: ReadonlyArray<ReturnType<typeof localThread>>;
    readonly hosts?: ReadonlyArray<string>;
    readonly hostCall?: (
      call: SshRemoteDispatch.SshHostToolCall,
    ) => Effect.Effect<unknown, SshRemoteDispatch.SshRemoteDispatchError>;
  },
  input: OrchestratorMcpThreadSearchInput,
  as: McpInvocationScope = scope,
) => {
  const calls: Array<SshRemoteDispatch.SshHostToolCall> = [];
  const searches: Array<ThreadSearch.ThreadMatchQuery> = [];
  const local = options.local ?? [];
  const threadLayer = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
    listProjectThreads: () => Effect.succeed(local),
  });
  const searchLayer = Layer.mock(ThreadSearch.ThreadSearch)({
    matchThreads: (query) =>
      Effect.sync(() => {
        searches.push(query);
        const only = query.threadIds === undefined ? null : new Set(query.threadIds);
        return local
          .filter((shell) => only === null || only.has(shell.id))
          .map((shell) => ({
            threadId: shell.id,
            projectId: shell.projectId,
            projectTitle: "here",
            title: shell.title,
            source: "title" as const,
            snippet: shell.title,
            messageCreatedAt: null,
          }));
      }),
  });
  const transport = Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
    connectedHosts: Effect.succeed(options.hosts ?? []),
    callHostTool: (call, authorize) =>
      Effect.gen(function* () {
        yield* authorize;
        calls.push(call);
        return yield* options.hostCall?.(call) ?? Effect.succeed({});
      }),
  });
  const hostLayer = HostThreads.layer.pipe(
    Layer.provide(
      Layer.mock(ThreadResultService.ThreadResultService)({
        forRun: () => Effect.succeed(null),
      }),
    ),
    Layer.provide(Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({})),
    Layer.provide(
      Layer.mock(LaunchWatchService.LaunchWatchService)({ find: () => Effect.succeed(null) }).pipe(
        Layer.provideMerge(Layer.mock(ThreadReplicaService.ThreadReplicaService)({})),
      ),
    ),
    Layer.provide(Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({})),
    Layer.provide(transport),
    Layer.provide(threadLayer),
  );
  const layer = ThreadSearchMcp.layer.pipe(
    Layer.provide(hostLayer),
    Layer.provide(transport),
    Layer.provide(threadLayer),
    Layer.provide(searchLayer),
    Layer.provide(NodeCrypto.layer),
  );
  return Effect.gen(function* () {
    const service = yield* ThreadSearchMcp.ThreadSearchMcpService;
    const result = yield* service.search(as, input).pipe(Effect.result);
    return { result, calls, searches };
  }).pipe(Effect.provide(layer));
};

const ids = (matches: ReadonlyArray<OrchestratorMcpThreadSearchMatch>) =>
  matches.map((match) => `${match.host ?? "here"}:${match.threadId}`);

describe("ThreadSearchMcpService", () => {
  it.effect.each(["allHosts", "hosts"] as const)(
    "returns fast hosts at the %s fan-out deadline without interrupting a slow launch",
    (selection) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const finished = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const returned = yield* Deferred.make<void>();
        const slow = Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Deferred.succeed(finished, undefined)),
          Effect.as({ matches: [remoteMatch("late", 40)], nextCursor: null, truncated: false }),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        );
        const fiber = yield* runSearch(
          {
            local: [localThread("local", 20)],
            hosts: ["fast", "slow"],
            hostCall: (call) =>
              call.host === "slow" ? slow : pagingHost([remoteMatch("fast", 30)])(call),
          },
          selection === "allHosts"
            ? { query: "modelflare", allHosts: true }
            : { query: "modelflare", hosts: ["fast", "slow"] },
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
        expect(ids(result.success.matches)).toEqual(
          selection === "allHosts" ? ["fast:fast", "here:local"] : ["fast:fast"],
        );
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

  it.effect("pages a fan-out newest first across hosts and reports a host that fails", () =>
    Effect.gen(function* () {
      const remote = [remoteMatch("r1", 40), remoteMatch("r2", 20), remoteMatch("r3", 5)];
      const options = {
        local: [localThread("l1", 30), localThread("l2", 10)],
        hosts: ["mac", "down"],
        hostCall: (call: SshRemoteDispatch.SshHostToolCall) =>
          call.host === "down"
            ? Effect.fail(
                new SshRemoteDispatch.SshRemoteDispatchError({
                  reason: "host_unavailable",
                  message: "down did not answer.",
                }),
              )
            : pagingHost(remote)(call),
      };
      const input = { query: "modelflare", allHosts: true, limit: 2 };

      const first = yield* runSearch(options, input);
      expect(first.result._tag).toBe("Success");
      if (first.result._tag !== "Success") return;
      expect(ids(first.result.success.matches)).toEqual(["mac:r1", "here:l1"]);
      expect(first.result.success.unavailableHosts).toEqual([
        { host: "down", code: "host_unavailable", message: "down did not answer." },
      ]);
      // The host searches only itself, every project, read-only.
      const macCall = first.calls.find((call) => call.host === "mac")!;
      expect(macCall).toMatchObject({ tool: "goat_thread_search", writes: false });
      expect(macCall.arguments).toEqual({ query: "modelflare", limit: 2, allProjects: true });
      expect(first.searches[0]?.projectId).toBeUndefined();

      const pages = [first.result.success];
      let cursor = first.result.success.nextCursor;
      while (cursor !== null) {
        const next = yield* runSearch(options, { ...input, cursor });
        if (next.result._tag !== "Success") throw new Error("page failed");
        // The host that failed stays out of later pages.
        expect(next.calls.map((call) => call.host)).toEqual(["mac"]);
        expect(next.result.success.unavailableHosts).toEqual([]);
        pages.push(next.result.success);
        cursor = next.result.success.nextCursor;
      }
      expect(pages.map((page) => ids(page.matches))).toEqual([
        ["mac:r1", "here:l1"],
        ["mac:r2", "here:l2"],
        ["mac:r3"],
      ]);
    }),
  );

  it.effect("filters local status and defaults to the caller's project", () =>
    Effect.gen(function* () {
      const { result, searches } = yield* runSearch(
        { local: [localThread("done", 30), localThread("quiet", 20, "idle")] },
        { query: "modelflare", statuses: ["idle"], updatedAfter: "2026-10-01T00:00:00Z" },
      );
      expect(searches[0]).toMatchObject({
        projectId: project,
        threadIds: [ThreadId.make("quiet")],
        updatedAfter: "2026-10-01T00:00:00.000Z",
      });
      expect(result._tag === "Success" && ids(result.success.matches)).toEqual(["here:quiet"]);
    }),
  );

  it.effect("names an outdated host instead of the argument it refused", () =>
    Effect.gen(function* () {
      const { result } = yield* runSearch(
        {
          hostCall: () =>
            Effect.fail(
              new SshRemoteDispatch.SshRemoteDispatchError({
                reason: "remote_refused",
                remoteCode: "invalid_request",
                message: "goat_thread_search does not take allProjects, so nothing ran.",
              }),
            ),
        },
        { query: "modelflare", host: "old" },
      );
      expect(result._tag === "Failure" && result.failure.message).toBe(
        "GOAT on old is too old to search with host filters; update GOAT there.",
      );
    }),
  );

  it.effect("refuses a project id across hosts and a foreign cursor", () =>
    Effect.gen(function* () {
      const projectAcrossHosts = yield* runSearch(
        {},
        { query: "modelflare", hosts: ["mac"], projectId: project },
      );
      expect(
        projectAcrossHosts.result._tag === "Failure" && projectAcrossHosts.result.failure.code,
      ).toBe("invalid_request");
      const offsetCursorForFanOut = yield* runSearch(
        {},
        { query: "modelflare", allHosts: true, cursor: "50" },
      );
      expect(
        offsetCursorForFanOut.result._tag === "Failure" &&
          offsetCursorForFanOut.result.failure.message,
      ).toBe("cursor is not a nextCursor from this kind of search.");
    }),
  );
});
