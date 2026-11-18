import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
} from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitManager from "../git/GitManager.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadPullRequestService from "./ThreadPullRequestService.ts";

const NOW = DateTime.makeUnsafe("2026-09-20T00:00:00.000Z");
const threadShell = (id: string): OrchestrationV2ThreadShell => {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: id,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
};

describe("ThreadPullRequestServiceV2 linked-thread refreshes", () => {
  it.effect("refreshes linked-thread readers at most every 10s while activity reorders them", () =>
    Effect.gen(function* () {
      const link = {
        host: "github.com",
        repository: "acme/web",
        number: 7,
        url: "https://github.com/acme/web/pull/7",
        source: "agent",
      };
      const linked = (id: string) =>
        ({
          type: "thread.pull-request-synced",
          threadId: ThreadId.make(id),
          payload: { ...threadShell(id), pullRequests: [link] },
        }) as unknown as OrchestrationV2DomainEvent;
      const activity = (id: string, second: number) =>
        ({
          type: "message.updated",
          threadId: ThreadId.make(id),
          occurredAt: DateTime.makeUnsafe(`2026-09-20T00:00:${String(second).padStart(2, "0")}Z`),
        }) as unknown as OrchestrationV2DomainEvent;
      const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const notified = yield* Queue.unbounded<void>();
      const dependencies = Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.fromQueue(domainEvents),
          getPullRequestSnapshot: () =>
            Effect.succeed({
              schemaVersion: 2,
              snapshotSequence: 1,
              threads: [],
              archivedThreads: [],
            }),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
        Layer.mock(GitManager.GitManager)({}),
        Layer.mock(PullRequestService.PullRequestService)({
          notifyLinkedThreadsChanged: Queue.offer(notified, undefined).pipe(Effect.asVoid),
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunOpportunisticWork: Effect.succeed(false),
        }),
        Layer.succeed(ServerActivation.ServerActivation, Effect.void),
        Layer.succeed(
          SecureRandom.SecureRandom,
          SecureRandom.make((size) => new Uint8Array(size).fill(1)),
        ),
        FileSystem.layerNoop({}),
        Path.layer,
      );
      yield* Effect.gen(function* () {
        const service = yield* ThreadPullRequestService.make;
        yield* service.start();

        yield* Queue.offerAll(domainEvents, [linked("a"), linked("b"), activity("a", 1)]);
        yield* Queue.takeN(notified, 3);
        // Two turns on threads linked to one pull request swap its top thread on every event.
        yield* Queue.offerAll(
          domainEvents,
          Array.from({ length: 20 }, (_, index) => activity(index % 2 ? "a" : "b", index + 2)),
        );
        // A link change still refreshes at once, and marks the burst as processed.
        yield* Queue.offer(domainEvents, linked("c"));
        yield* Queue.take(notified);
        expect(yield* Queue.size(notified)).toBe(0);

        yield* TestClock.adjust("10 seconds");
        yield* Queue.take(notified);
        yield* TestClock.adjust("10 seconds");
        expect(yield* Queue.size(notified)).toBe(0);
      }).pipe(Effect.provide(dependencies));
    }),
  );
});
