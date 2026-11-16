import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type ModelSelection,
  ProjectId,
  type PullRequestDetail,
  ThreadId,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as PullRequestWatchReactor from "./PullRequestWatchReactor.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import {
  layerCheckpointStoreTest,
  layerGitWorkflowTest,
  layerPlatformTest,
  layerProjectServiceTest,
  layerServerConfig,
  layerTestProviderInstanceRegistry,
  modelSelection,
  watchedPullRequestDetail,
} from "./runtimeLayer.testkit.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const layerTest = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ProjectStore.layer,
  ProjectionStore.layer,
  EffectOutbox.layer,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerProjectServiceTest),
  Layer.provide(layerPlatformTest),
);

const seedProject = (input: {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly defaultModelSelection: ModelSelection | null;
  readonly createdAt: string;
}) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`seed:${input.projectId}`),
      aggregateKind: "project",
      aggregateId: input.projectId,
      occurredAt: input.createdAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: input.projectId,
        title: input.title,
        workspaceRoot: input.workspaceRoot,
        defaultModelSelection: input.defaultModelSelection,
        scripts: [],
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      },
    }),
  );

describe("pull request watch host events", () => {
  it.effect(
    "reads a watched pull request when the host reports a change, and wakes once per change",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make("runtime-pull-request-watch-host-event");
        const projectId = ProjectId.make("pr-watch-host-event-project");
        yield* seedProject({
          projectId,
          title: "Watch host events",
          workspaceRoot: "/workspace/watch-host-event",
          defaultModelSelection: null,
          createdAt: "2026-10-01T00:00:00.000Z",
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("pr-watch-host-event-create"),
          threadId,
          projectId,
          title: "Watch host events",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        const key = { host: "github.com", repository: "goat-si/goat", number: 15 };
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make("pr-watch-host-event-start"),
          threadId,
          ...key,
          watching: true,
          link: { url: "https://github.com/goat-si/goat/pull/15", source: "agent" },
        });

        let checks: PullRequestDetail["checks"] = [
          { name: "lint", status: "pending", description: null, url: null, required: true },
        ];
        let fingerprints = 0;
        const events = yield* Queue.unbounded<void>();
        const following = yield* Deferred.make<void>();
        const detailReads = yield* Queue.unbounded<void>();
        const host = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          ServerSettings.layerTest(),
          Layer.mock(PullRequestService.PullRequestService)({
            detail: () =>
              Queue.offer(detailReads, undefined).pipe(
                Effect.as({
                  ...watchedPullRequestDetail({
                    projectId,
                    number: 15,
                    at: "2026-10-02T12:00:00.000Z",
                  }),
                  headSha: "aaaaaaaaaa",
                  checks,
                }),
              ),
            activity: () =>
              Effect.succeed({
                comments: [],
                commentCount: 0,
                commentsTruncated: false,
                reviewThreads: [],
                commits: [],
              }),
            // A fresh fingerprint every time, so every pass reads the detail.
            watchFingerprint: () =>
              Effect.sync(() => ({ status: String(++fingerprints), remarks: "" })),
            invalidate: () => Effect.void,
            changes: () =>
              Stream.fromEffectDrain(Deferred.succeed(following, undefined)).pipe(
                Stream.concat(Stream.fromQueue(events)),
              ),
          }),
        );
        const wakes = Effect.map(
          orchestrator.getThreadRecords(threadId, ["messages"]),
          ({ messages }) =>
            messages.filter(
              (message) => message.notification !== undefined && message.notification !== null,
            ),
        );
        const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* reactor.start();
        // The feed starts after the first sweep has read the pull request.
        yield* Deferred.await(following);
        yield* Queue.take(detailReads);

        checks = [
          { name: "lint", status: "failure", description: null, url: null, required: true },
        ];
        yield* Queue.offer(events, undefined);
        // The clock never moves, so no sweep can be the one that reads the failure.
        yield* Queue.take(detailReads);
        // Nothing new: this read must compare against the watch the last one recorded.
        yield* Queue.offer(events, undefined);
        yield* Queue.take(detailReads);
        // A sweep waits for the change read in flight.
        yield* reactor.sweep;
        yield* worker.drain();
        const woken = yield* wakes;
        assert.lengthOf(woken, 1);
        assert.include(woken[0]?.notification?.summary ?? "", "failed");

        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make("pr-watch-host-event-end"),
          threadId,
          ...key,
          watching: false,
        });
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});

describe("pull request watch host event feeds", () => {
  it("follows at most 64 pull requests, the same ones whatever order the sweep found them in", () => {
    const candidates = Array.from(
      { length: 70 },
      (_, index) => [`github.com goat-si/goat#${String(index).padStart(3, "0")}`, index] as const,
    );
    const forward = PullRequestWatchReactor.feedsToFollow(candidates);
    const backward = PullRequestWatchReactor.feedsToFollow(candidates.toReversed());
    assert.equal(PullRequestWatchReactor.MAX_EVENT_FEEDS, 64);
    assert.deepEqual(
      [...forward.keys()],
      candidates.slice(0, 64).map(([key]) => key),
    );
    assert.deepEqual([...backward.keys()], [...forward.keys()]);
  });
});
