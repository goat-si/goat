import {
  ProjectId,
  ProviderInstanceId,
  SourceControlProviderKind,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
} from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitManager from "../git/GitManager.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadPullRequestService from "./ThreadPullRequestService.ts";

describe("ThreadPullRequestService cadence", () => {
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

  it.effect(
    "rechecks missing pull requests after thirty minutes while explicit events refresh immediately",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const parent = {
            ...threadShell("parent-thread"),
            branch: "feature/parent",
            worktreePath: "/workspace/parent",
          };
          const child: OrchestrationV2ThreadShell = {
            ...threadShell("child-thread"),
            branch: "t3/reply-ok",
            worktreePath: "/workspace/child",
            lineage: {
              rootThreadId: parent.id,
              parentThreadId: parent.id,
              relationshipToParent: "subagent",
            },
          };
          const project: OrchestrationProjectShell = {
            id: parent.projectId,
            title: "Project",
            workspaceRoot: "/workspace/project",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          };
          const activation = yield* Deferred.make<void>();
          const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
          const sweeps = yield* Queue.unbounded<void>();
          const childLookup = yield* Deferred.make<void>();
          const lookups: Array<{ readonly branch: string; readonly refresh: boolean }> = [];
          const dependencies = Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.fromQueue(domainEvents),
              getPullRequestSnapshot: ({ threadId }) =>
                threadId !== undefined
                  ? Effect.succeed({ snapshotSequence: 1, threads: [child] })
                  : Queue.offer(sweeps, undefined).pipe(
                      Effect.as({
                        schemaVersion: 2,
                        snapshotSequence: 1,
                        threads: [parent, child],
                        archivedThreads: [],
                      }),
                    ),
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              listShells: () => Effect.succeed([project]),
              getShell: () => Effect.succeedSome(project),
            }),
            Layer.mock(GitManager.GitManager)({
              branchPullRequest: (input, options) =>
                Effect.gen(function* () {
                  const refresh = options?.refresh ?? false;
                  lookups.push({ branch: input.branch, refresh });
                  if (input.branch === child.branch && refresh) {
                    yield* Deferred.succeed(childLookup, undefined);
                  }
                  return null;
                }),
            }),
            Layer.mock(PullRequestService.PullRequestService)({
              subscribeRefreshes: Stream.never,
              notifyLinkedThreadsChanged: Effect.void,
            }),
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
              resolve: () =>
                Effect.succeed({
                  canonicalKey: "github.com/acme/project",
                  locator: {
                    source: "git-remote" as const,
                    remoteName: "origin",
                    remoteUrl: "git@github.com:acme/project.git",
                  },
                  provider: SourceControlProviderKind.make("github"),
                  owner: "acme",
                  name: "project",
                }),
            }),
            Layer.mock(BackgroundPolicy.BackgroundPolicy)({
              shouldRunScopeWork: () => Effect.succeed(true),
              shouldRunOpportunisticWork: Effect.succeed(true),
            }),
            Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
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
            yield* Deferred.succeed(activation, undefined);

            yield* Queue.take(sweeps);
            yield* service.drain;
            for (let minute = 1; minute <= 29; minute += 1) {
              yield* TestClock.adjust("1 minute");
              yield* Queue.take(sweeps);
              yield* service.drain;
            }
            expect(lookups.map((lookup) => lookup.branch)).toEqual([parent.branch]);
            yield* TestClock.adjust("1 minute");
            yield* Queue.take(sweeps);
            yield* service.drain;
            const sweepLookups = lookups.map((lookup) => lookup.branch).toSorted();

            // The child's own turn still discovers its pull request.
            yield* Queue.offer(domainEvents, {
              type: "checkpoint.captured",
              threadId: child.id,
            } as OrchestrationV2DomainEvent);
            yield* Deferred.await(childLookup);
            yield* service.drain;

            expect(sweepLookups).toEqual([parent.branch, parent.branch]);
            expect(lookups.slice(sweepLookups.length)).toEqual([
              { branch: child.branch, refresh: true },
            ]);
          }).pipe(Effect.provide(dependencies));
        }),
      ),
  );

  it.effect("refreshes immediately during backoff and coalesces a burst", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const parent = {
          ...threadShell("parent-thread"),
          branch: "feature/parent",
          worktreePath: "/workspace/parent",
        };
        const child: OrchestrationV2ThreadShell = {
          ...threadShell("child-thread"),
          branch: "t3/reply-ok",
          worktreePath: "/workspace/child",
          lineage: {
            rootThreadId: parent.id,
            parentThreadId: parent.id,
            relationshipToParent: "subagent",
          },
        };
        const project: OrchestrationProjectShell = {
          id: parent.projectId,
          title: "Project",
          workspaceRoot: "/workspace/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        };
        const activation = yield* Deferred.make<void>();
        const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
        const sweeps = yield* Queue.unbounded<void>();
        const childLookup = yield* Deferred.make<void>();
        const refreshes = yield* Queue.unbounded<number>();
        const firstRefresh = yield* Deferred.make<void>();
        const secondRefresh = yield* Deferred.make<void>();
        const allSeen = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let refreshCount = 0;
        const lookups: Array<{ readonly branch: string; readonly refresh: boolean }> = [];
        const dependencies = Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(domainEvents),
            getPullRequestSnapshot: ({ threadId }) =>
              threadId !== undefined
                ? Effect.succeed({ snapshotSequence: 1, threads: [child] })
                : Queue.offer(sweeps, undefined).pipe(
                    Effect.as({
                      schemaVersion: 2,
                      snapshotSequence: 1,
                      threads: [parent, child],
                      archivedThreads: [],
                    }),
                  ),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () => Effect.succeed([project]),
            getShell: () => Effect.succeedSome(project),
          }),
          Layer.mock(GitManager.GitManager)({
            branchPullRequest: (input, options) =>
              Effect.gen(function* () {
                const refresh = options?.refresh ?? false;
                lookups.push({ branch: input.branch, refresh });
                if (input.branch === parent.branch && refresh) {
                  refreshCount += 1;
                  if (refreshCount === 1) {
                    yield* Deferred.succeed(firstRefresh, undefined);
                    yield* Deferred.await(release);
                  } else {
                    yield* Deferred.succeed(secondRefresh, undefined);
                  }
                }
                if (input.branch === child.branch && refresh) {
                  yield* Deferred.succeed(childLookup, undefined);
                }
                return null;
              }),
          }),
          Layer.mock(PullRequestService.PullRequestService)({
            subscribeRefreshes: Stream.fromQueue(refreshes).pipe(
              Stream.tap((value) =>
                value === 10 ? Deferred.succeed(allSeen, undefined) : Effect.void,
              ),
            ),
            notifyLinkedThreadsChanged: Effect.void,
          }),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
            resolve: () =>
              Effect.succeed({
                canonicalKey: "github.com/acme/project",
                locator: {
                  source: "git-remote" as const,
                  remoteName: "origin",
                  remoteUrl: "git@github.com:acme/project.git",
                },
                provider: SourceControlProviderKind.make("github"),
                owner: "acme",
                name: "project",
              }),
          }),
          Layer.mock(BackgroundPolicy.BackgroundPolicy)({
            shouldRunScopeWork: () => Effect.succeed(true),
            shouldRunOpportunisticWork: Effect.succeed(true),
          }),
          Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
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
          yield* Deferred.succeed(activation, undefined);

          yield* Queue.take(sweeps);
          yield* service.drain;
          yield* Queue.offer(refreshes, 1);
          yield* Deferred.await(firstRefresh);
          for (let value = 2; value <= 10; value++) yield* Queue.offer(refreshes, value);
          yield* Deferred.await(allSeen);
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(secondRefresh);
          yield* service.drain;
          expect(lookups.map((lookup) => lookup.branch)).toEqual([
            parent.branch,
            parent.branch,
            parent.branch,
          ]);
          expect(refreshCount).toBe(2);
        }).pipe(Effect.provide(dependencies));
      }),
    ),
  );
});
