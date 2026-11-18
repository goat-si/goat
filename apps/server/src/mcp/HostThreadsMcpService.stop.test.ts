import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";

import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import type { LaunchWatch } from "./launchWatch.ts";

import { scope, remoteStop, runService } from "./HostThreadsMcpService.testkit.ts";

describe("HostThreadsMcpService stop", () => {
  it.effect.each([
    ["a newer host", remoteStop],
    ["a host that predates it", undefined],
  ] as const)("reports the unanswered Stop that %s sends with a remote status", ([, stop]) =>
    Effect.gen(function* () {
      const at = "2026-10-13T01:00:00.000Z";
      const { result } = yield* runService(
        {
          interactionMode: "default",
          watch: {
            pendingRuns: [],
            reportedRuns: [],
            notifyWebhook: false,
            webhookTarget: null,
          } as unknown as LaunchWatch,
          hostCall: () =>
            Effect.succeed({
              ...(stop === undefined ? {} : { stop }),
              threadId: "remote-1",
              title: "Fix the flake",
              phase: "running",
              terminal: false,
              run: null,
              queuedRunId: null,
              pendingRequest: null,
              lastActivityAt: at,
              lastMessage: null,
              lastError: null,
              watch: { pendingRunIds: [], lastReportedRunId: null, webhook: false },
            }),
        },
        (service) =>
          service.threadStatus(scope, { host: "box", threadId: ThreadId.make("remote-1") }),
      );
      if (result._tag !== "Success") return yield* Effect.die(result);
      expect(result.success.stop).toEqual(stop);
    }),
  );

  it.effect.each([
    ["a newer host", remoteStop],
    ["a host that predates it", undefined],
  ] as const)("the thread-read fallback reports the unanswered Stop that %s sends", ([, stop]) =>
    Effect.gen(function* () {
      const at = "2026-10-13T01:00:00.000Z";
      const { result } = yield* runService(
        {
          interactionMode: "default",
          watch: {
            pendingRuns: [],
            reportedRuns: [],
            notifyWebhook: false,
            webhookTarget: null,
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
                  ...(stop === undefined ? {} : { stop }),
                  thread: {
                    threadId: "remote-1",
                    projectId: "remote-project",
                    title: "Fix the flake",
                    createdBy: "agent",
                    creationSource: "mcp",
                    status: "running",
                    latestRunId: "run-2",
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
                    runCount: 2,
                    itemCount: 0,
                    pendingRequestCount: 0,
                    archived: false,
                    settled: false,
                    settledAt: null,
                    snoozed: false,
                    snoozedUntil: null,
                    createdAt: at,
                    updatedAt: at,
                  },
                  recentRuns: [],
                  items: [],
                  nextPosition: null,
                  hasMore: false,
                }),
        },
        (service) =>
          service.threadStatus(scope, { host: "box", threadId: ThreadId.make("remote-1") }),
      );
      if (result._tag !== "Success") return yield* Effect.die(result);
      expect(result.success.stop).toEqual(stop);
    }),
  );
});
