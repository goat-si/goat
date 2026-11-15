import {
  SourceControlProviderKind,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Command as OrchestrationCommand,
  type OrchestrationV2DomainEvent,
  type OrchestrationProjectShell,
  type PullRequestRef,
  type PullRequestStack,
  type PullRequestSummary,
  type ThreadPullRequestKey,
  type ThreadPullRequestLink,
  type ThreadPullRequestSnapshot,
  PullRequestOperationError,
} from "@goat/contracts";
import { assert } from "@effect/vitest";
import * as Stream from "effect/Stream";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";
import * as GitManager from "../../git/GitManager.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
import * as ServerActivation from "../../serverActivation.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as PullRequestSyncReactor from "../PullRequestSyncReactor.ts";
import type { PullRequestTestThread } from "./pullRequestFixtures.ts";

export const NOW = "2026-08-28T12:00:00.000Z";
export const PROJECT_ID = ProjectId.make("sync-project");

export type SyncCommand = Extract<
  OrchestrationCommand,
  { readonly type: "thread.pull-request-link.sync" }
>;
type LinkCommand = Extract<OrchestrationCommand, { readonly type: "thread.pull-request.link" }>;

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(1),
  digest: (_algorithm, data) => Effect.succeed(data),
});

function makeProject(id: ProjectId = PROJECT_ID): OrchestrationProjectShell {
  return {
    id,
    title: `Project ${id}`,
    workspaceRoot: "/workspace/project",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: NOW,
  };
}

export function makeThread(
  id: string,
  overrides: Partial<PullRequestTestThread> = {},
): PullRequestTestThread {
  return {
    id: ThreadId.make(id),
    projectId: PROJECT_ID,
    title: id,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    latestUserMessageAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

export function makeLink(
  number: number,
  snapshot: Partial<ThreadPullRequestSnapshot> | null = null,
  overrides: Partial<ThreadPullRequestLink> = {},
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "owner/repository",
    number,
    url: `https://github.com/owner/repository/pull/${number}`,
    source: "manual",
    linkedAt: "2026-08-10T00:00:00.000Z",
    snapshot:
      snapshot === null
        ? null
        : {
            state: "open",
            title: "Pull request",
            headBranch: "feature",
            baseBranch: "main",
            isDraft: false,
            updatedAt: "2026-08-27T00:00:00.000Z",
            syncedAt: "2026-08-27T00:00:00.000Z",
            ...snapshot,
          },
    stack: null,
    ...overrides,
  };
}

export interface TestShellSnapshot {
  readonly snapshotSequence: number;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly threads: ReadonlyArray<PullRequestTestThread>;
  readonly updatedAt: string;
}

export function makeSnapshot(
  threads: ReadonlyArray<PullRequestTestThread>,
  snapshotSequence = 1,
): TestShellSnapshot {
  return {
    snapshotSequence,
    projects: [makeProject()],
    threads,
    updatedAt: NOW,
  };
}

export function makeSummary(
  input: PullRequestRef,
  overrides: Partial<PullRequestSummary> = {},
): PullRequestSummary {
  return {
    provider: SourceControlProviderKind.make("github"),
    projectId: input.projectId,
    repository: input.repository,
    number: input.number,
    title: "Pull request",
    url: `https://github.com/${input.repository}/pull/${input.number}`,
    state: "open",
    headBranch: "feature",
    baseBranch: "main",
    updatedAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

interface HarnessOptions {
  readonly batchesReads?: (input: PullRequestRef) => boolean;
  readonly batchesReadsError?: (input: PullRequestRef) => PullRequestOperationError | undefined;
  readonly invalidate?: PullRequestService.PullRequestService["Service"]["invalidate"];
  readonly snapshot: TestShellSnapshot;
  readonly summary?: (
    input: PullRequestRef,
  ) => Effect.Effect<PullRequestSummary, PullRequestOperationError>;
  readonly stack?: (
    input: PullRequestRef,
  ) => Effect.Effect<PullRequestStack | null, PullRequestOperationError>;
  readonly onSync?: (command: SyncCommand) => Effect.Effect<unknown>;
}

export const makeHarness = Effect.fn("makePullRequestSyncHarness")(function* (
  options: HarnessOptions,
) {
  const activation = yield* Deferred.make<void>();
  const snapshots = yield* Ref.make(options.snapshot);
  const snapshotReads = yield* Queue.unbounded<void>();
  const shellSnapshotReads = yield* Ref.make(0);
  const syncCommands = yield* Ref.make<ReadonlyArray<SyncCommand>>([]);
  const linkCommands = yield* Ref.make<ReadonlyArray<LinkCommand>>([]);
  const summaryCalls = yield* Ref.make<ReadonlyArray<PullRequestRef>>([]);
  const stackCalls = yield* Ref.make<ReadonlyArray<PullRequestRef>>([]);
  const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const stateChanges = yield* Queue.unbounded<ThreadPullRequestKey>();

  const summary: PullRequestService.PullRequestService["Service"]["summary"] = (
    input,
    readOptions,
  ) =>
    Effect.gen(function* () {
      assert.strictEqual(readOptions?.recoverTransientFailure, false);
      yield* Ref.update(summaryCalls, (calls) => [...calls, input]);
      return yield* options.summary?.(input) ?? Effect.succeed(makeSummary(input));
    });

  const stack: PullRequestService.PullRequestService["Service"]["stack"] = (input, readOptions) =>
    Effect.gen(function* () {
      assert.strictEqual(readOptions?.includeDetails, false);
      yield* Ref.update(stackCalls, (calls) => [...calls, input]);
      return yield* options.stack?.(input) ?? Effect.succeed(null);
    });

  const dispatch: Orchestrator.OrchestratorV2Shape["dispatch"] = (command) => {
    if (command.type === "thread.pull-request-link.sync") {
      return Ref.update(syncCommands, (recorded) => [...recorded, command]).pipe(
        Effect.andThen(options.onSync?.(command) ?? Effect.void),
        Effect.as({ sequence: 1, storedEvents: [] }),
      );
    }
    if (command.type === "thread.pull-request.link") {
      return Ref.update(linkCommands, (recorded) => [...recorded, command]).pipe(
        Effect.as({ sequence: 1, storedEvents: [] }),
      );
    }
    return Effect.die(new Error(`Unexpected command: ${command.type}`));
  };

  const layerDependencies = Layer.mergeAll(
    Layer.mock(PullRequestService.PullRequestService)({
      withSharedProjectReads: (effect) => effect,
      batchesReads: (input: PullRequestRef) => {
        const error = options.batchesReadsError?.(input);
        return error === undefined
          ? Effect.succeed(options.batchesReads?.(input) ?? true)
          : Effect.fail(error);
      },
      summary,
      stack,
      invalidate: options.invalidate ?? (() => Effect.void),
      subscribeStateChanges: Effect.succeed(Stream.fromQueue(stateChanges)),
    }),
    Layer.mock(GitManager.GitManager)({
      subscribePullRequestStateChanges: Effect.succeed(Stream.empty),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadsWithPullRequests: (threadId) =>
        Queue.offer(snapshotReads, undefined).pipe(
          Effect.andThen(Ref.get(snapshots)),
          Effect.map((snapshot) =>
            snapshot.threads
              .filter(
                (thread) =>
                  (threadId === undefined || thread.id === threadId) &&
                  thread.archivedAt === null &&
                  thread.pullRequests.length > 0,
              )
              .map((thread) => ({
                id: thread.id,
                projectId: thread.projectId,
                lineage: {
                  parentThreadId: null,
                  relationshipToParent: null,
                  rootThreadId: thread.id,
                },
                settledOverride: thread.settledOverride,
                settledAt: thread.settledAt === null ? null : DateTime.makeUnsafe(thread.settledAt),
                updatedAt: DateTime.makeUnsafe(0),
                pullRequests: thread.pullRequests,
              })),
          ),
        ),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getShellSnapshot: () =>
        Ref.update(shellSnapshotReads, (count) => count + 1).pipe(
          Effect.andThen(Effect.die(new Error("pull request sync must not read the shell"))),
        ),
      dispatch,
      streamDomainEvents: Stream.fromQueue(domainEvents),
    }),
    Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );

  return {
    activation,
    snapshots,
    snapshotReads,
    shellSnapshotReads,
    syncCommands,
    linkCommands,
    summaryCalls,
    stackCalls,
    domainEvents,
    stateChanges,
    layer: PullRequestSyncReactor.layer.pipe(Layer.provide(layerDependencies)),
  };
});

export type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

export const startAndSweep = Effect.fn("startPullRequestSyncHarness")(function* (fixture: Harness) {
  const reactor = yield* PullRequestSyncReactor.PullRequestSyncReactor;
  yield* reactor.start();
  yield* Deferred.succeed(fixture.activation, undefined);
  yield* Queue.take(fixture.snapshotReads);
  yield* reactor.drain;
  return reactor;
});

export const sweepAgain = Effect.fn("sweepPullRequestSyncHarness")(function* (
  fixture: Harness,
  reactor: PullRequestSyncReactor.PullRequestSyncReactor["Service"],
) {
  yield* TestClock.adjust("1 minute");
  yield* Queue.take(fixture.snapshotReads);
  yield* reactor.drain;
});
