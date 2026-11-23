import {
  ProjectId,
  ProviderInstanceId,
  SourceControlProviderKind,
  ThreadId,
  type OrchestrationProjectShell,
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
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitManager from "../git/GitManager.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadPullRequestService from "./ThreadPullRequestService.ts";

describe("startup backfill", () => {
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

  it.effect("startup backfill looks up a branch once for threads whose worktrees are gone", () =>
    Effect.gen(function* () {
      // Removed worktree folders all fall back to the project root, so they share one lookup.
      const shared = ["a", "b", "c", "d"].map((suffix) => ({
        ...threadShell(`gone-worktree-${suffix}`),
        branch: "feature/shared",
        worktreePath: `/workspace/worktrees/gone-${suffix}`,
        settledAt: NOW,
      }));
      // Every start repeats the backfill, so it reads only the most recently updated threads.
      const older = Array.from({ length: 100 }, (_, index) => ({
        ...threadShell(`old-${index}`),
        branch: `goat/old-${index}`,
        worktreePath: `/workspace/worktrees/old-${index}`,
        settledAt: NOW,
        updatedAt: DateTime.subtract(NOW, { minutes: index + 1 }),
      }));
      const threads = [...older.toReversed(), ...shared];
      const project: OrchestrationProjectShell = {
        id: threads[0]!.projectId,
        title: "Project",
        workspaceRoot: "/workspace/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      };
      const activation = yield* Deferred.make<void>();
      const sweeps = yield* Queue.unbounded<void>();
      const lookups: Array<{ readonly cwd: string; readonly branch: string }> = [];
      const dependencies = Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.never,
          getPullRequestSnapshot: () =>
            Queue.offer(sweeps, undefined).pipe(
              Effect.as({
                schemaVersion: 2,
                snapshotSequence: 1,
                threads,
                archivedThreads: [],
              }),
            ),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          listShells: () => Effect.succeed([project]),
          getShell: () => Effect.succeedSome(project),
        }),
        Layer.mock(GitManager.GitManager)({
          branchPullRequest: (input) =>
            Effect.sync(() => {
              lookups.push({ cwd: input.cwd, branch: input.branch });
              return null;
            }),
        }),
        Layer.mock(PullRequestService.PullRequestService)({
          notifyLinkedThreadsChanged: Effect.void,
          subscribeRefreshes: Stream.never,
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

        expect(lookups.map((lookup) => lookup.branch).toSorted()).toEqual(
          ["feature/shared", ...older.slice(0, 60).map((thread) => thread.branch)].toSorted(),
        );
        expect(lookups.every((lookup) => lookup.cwd === project.workspaceRoot)).toBe(true);
      }).pipe(Effect.provide(dependencies));
    }),
  );
});
