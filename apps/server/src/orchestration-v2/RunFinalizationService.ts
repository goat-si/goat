import { CheckpointScopeId, ProjectId, RunId, ThreadId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import * as ProjectEnrichment from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class RunFinalizationError extends Schema.TaggedError<RunFinalizationError>()(
  "RunFinalizationError",
  {
    threadId: ThreadId,
    runId: RunId,
    scopeId: CheckpointScopeId,
    operation: Schema.Literals(["capture-checkpoint", "refresh-workspace"]),
    cause: Schema.Defect(),
  },
) {}

export class RunFinalizationRefreshError extends Schema.TaggedError<RunFinalizationRefreshError>()(
  "RunFinalizationRefreshError",
  { cwd: Schema.String, cause: Schema.Defect() },
) {}

export class RunFinalizationObserver extends Context.Reference<{
  readonly refreshAfterTurn: (projectId: ProjectId) => Effect.Effect<void>;
  readonly refresh: (input: {
    readonly cwd: string;
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<void, RunFinalizationRefreshError>;
}>("goat/orchestration-v2/RunFinalizationObserver", {
  defaultValue: () => ({ refresh: () => Effect.void, refreshAfterTurn: () => Effect.void }),
}) {}

export class RunFinalizationService extends Context.Service<
  RunFinalizationService,
  {
    readonly finalize: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly scopeId: CheckpointScopeId;
    }) => Effect.Effect<void, RunFinalizationError>;
  }
>()("goat/orchestration-v2/RunFinalizationService") {}

const make = Effect.gen(function* () {
  const checkpointCapture = yield* CheckpointCapture.CheckpointCaptureServiceV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const observer = yield* RunFinalizationObserver;

  const refreshDisplay = Effect.fn("RunFinalizationService.refreshDisplay")(function* (
    input: Parameters<RunFinalizationService["Service"]["finalize"]>[0],
  ) {
    const projection = yield* projections.getCheckpointContext(input.threadId);
    const cwd = projection.checkpointScopes.find((scope) => scope.id === input.scopeId)?.cwd;
    if (cwd !== undefined)
      yield* observer.refresh({ cwd, threadId: input.threadId, runId: input.runId });
  });

  const finalize: RunFinalizationService["Service"]["finalize"] = Effect.fn(
    "RunFinalizationService.finalize",
  )(function* (input) {
    yield* checkpointCapture
      .execute(input)
      .pipe(
        Effect.mapError(
          (cause) => new RunFinalizationError({ ...input, operation: "capture-checkpoint", cause }),
        ),
      );
    yield* refreshDisplay(input).pipe(
      Effect.timeout("10 seconds"),
      Effect.catch((cause) =>
        Effect.logWarning("orchestration-v2.finalization-display-refresh-unavailable", {
          ...input,
          category: cause._tag,
        }),
      ),
    );
  });
  return RunFinalizationService.of({ finalize });
});

export const layer = Layer.effect(RunFinalizationService, make);

export const layerObserver = Layer.effect(
  RunFinalizationObserver,
  Effect.gen(function* () {
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    const vcsStatus = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const pullRequests = yield* PullRequestService.PullRequestService;
    const pullRequestLookups = yield* FiberMap.make<string>();
    const identityRefreshes = yield* FiberMap.make<ProjectId>();
    const projects = yield* ProjectService.ProjectService;
    const enrichment = yield* ProjectEnrichment.ProjectEnrichmentService;
    const refreshing = new Set<ProjectId>();
    const refreshIdentity = Effect.fn("RunFinalizationService.refreshIdentity")(
      function* (projectId: ProjectId) {
        const project = yield* projects.getById(projectId);
        if (Option.isSome(project))
          yield* enrichment.refreshRepositoryIdentity(project.value.workspaceRoot);
      },
      Effect.catch((error) =>
        Effect.logWarning("Failed to refresh project identity", { category: error._tag }),
      ),
    );
    return {
      refreshAfterTurn: pullRequests.refreshAfterTurn,
      refresh: Effect.fn("RunFinalizationService.refresh")(
        function* ({ cwd, threadId, runId }) {
          const [, local] = yield* Effect.all(
            [workspaceEntries.refresh(cwd), vcsStatus.refreshLocalStatus(cwd)],
            { concurrency: "unbounded" },
          );
          const thread = yield* projections.getThreadShell(threadId);
          if (!thread) return;
          if (!refreshing.has(thread.projectId) && refreshing.size < 512) {
            refreshing.add(thread.projectId);
            yield* refreshIdentity(thread.projectId).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  refreshing.delete(thread.projectId);
                }),
              ),
              FiberMap.run(identityRefreshes, thread.projectId),
            );
          }
          if (local.refName === null || local.isDefaultRef || thread.branch !== local.refName)
            return;
          if (thread.activeRunId !== null && thread.activeRunId !== runId) return;
          // The forge CLI can take minutes, so the next turn must not wait for it. A newer
          // turn's lookup replaces a running one instead of queueing behind the cwd's lock.
          yield* vcsStatus.refreshPullRequestStatus(cwd).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to refresh pull request status after run completion", {
                threadId,
                cwd,
                detail: error.message,
              }),
            ),
            FiberMap.run(pullRequestLookups, cwd),
          );
        },
        (effect, { cwd }) =>
          effect.pipe(Effect.mapError((cause) => new RunFinalizationRefreshError({ cwd, cause }))),
      ),
    };
  }),
);
