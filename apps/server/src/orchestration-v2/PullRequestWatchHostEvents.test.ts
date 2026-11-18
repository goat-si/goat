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
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

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
import * as PullRequestEventFeeds from "./goat/PullRequestEventFeeds.ts";
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

const watchPullRequest = Effect.fn("test.watchPullRequest")(function* (
  name: string,
  number: number,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadId = ThreadId.make(`${name}-thread`);
  const projectId = ProjectId.make(`${name}-project`);
  yield* seedProject({
    projectId,
    title: name,
    workspaceRoot: `/workspace/${name}`,
    defaultModelSelection: null,
    createdAt: "2026-10-01T00:00:00.000Z",
  });
  yield* orchestrator.dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make(`${name}-create`),
    threadId,
    projectId,
    title: name,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  });
  yield* orchestrator.dispatch({
    type: "thread.pull-request.watch",
    commandId: CommandId.make(`${name}-watch`),
    threadId,
    host: "github.com",
    repository: "goat-si/goat",
    number,
    watching: true,
    link: { url: `https://github.com/goat-si/goat/pull/${number}`, source: "agent" },
  });
  return { orchestrator, threadId, projectId };
});

/** A host whose every read finds a new fingerprint, so each pass reads the detail. */
const fakeHost = (input: {
  readonly projectId: ProjectId;
  readonly number: number;
  readonly detailReads: Queue.Queue<void>;
  readonly changes: (input: { readonly host?: string | undefined }) => Stream.Stream<void>;
  readonly followsChanges?: (input: { readonly host?: string | undefined }) => boolean;
}) => {
  let fingerprints = 0;
  return Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    ServerSettings.layerTest(),
    Layer.mock(PullRequestService.PullRequestService)({
      detail: (read) =>
        Queue.offer(input.detailReads, undefined).pipe(
          Effect.as({
            ...watchedPullRequestDetail({
              projectId: input.projectId,
              number: read.number,
              at: "2026-10-02T12:00:00.000Z",
            }),
            headSha: "aaaaaaaaaa",
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
      watchFingerprint: () => Effect.sync(() => ({ status: String(++fingerprints), remarks: "" })),
      invalidate: () => Effect.void,
      changes: input.changes,
      followsChanges: (ref) => Effect.succeed(input.followsChanges?.(ref) ?? true),
    }),
  );
};

describe("pull request watch host events", () => {
  it.effect("opens a host feed for a watched pull request once the first sweep has read it", () =>
    Effect.gen(function* () {
      const { projectId } = yield* watchPullRequest("pr-watch-host-feed-opened", 16);
      const following = yield* Deferred.make<void>();
      const detailReads = yield* Queue.unbounded<void>();
      const reactor = yield* PullRequestWatchReactor.make.pipe(
        Effect.provide(
          fakeHost({
            projectId,
            number: 16,
            detailReads,
            changes: () =>
              Stream.fromEffectDrain(Deferred.succeed(following, undefined)).pipe(
                Stream.concat(Stream.never),
              ),
          }),
        ),
      );
      yield* reactor.start();
      yield* Queue.take(detailReads);
      // The next sweep reads again only after the first one has opened its feeds.
      const opened = yield* Effect.raceFirst(
        Deferred.await(following).pipe(Effect.as(true)),
        Queue.take(detailReads).pipe(Effect.as(false)),
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("2 minutes");
      assert.isTrue(yield* Fiber.join(opened), "the reactor never opened a host feed");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("reads once for a burst of host events that lands inside the 20-second settle", () =>
    Effect.gen(function* () {
      const { projectId } = yield* watchPullRequest("pr-watch-host-burst", 17);
      const following = yield* Deferred.make<void>();
      const detailReads = yield* Queue.unbounded<void>();
      const events = yield* Queue.unbounded<void>();
      const received = yield* Queue.unbounded<void>();
      const reactor = yield* PullRequestWatchReactor.make.pipe(
        Effect.provide(
          fakeHost({
            projectId,
            number: 17,
            detailReads,
            changes: () =>
              Stream.fromEffectDrain(Deferred.succeed(following, undefined)).pipe(
                Stream.concat(
                  Stream.fromQueue(events).pipe(Stream.tap(() => Queue.offer(received, undefined))),
                ),
              ),
          }),
        ),
      );
      yield* reactor.start();
      yield* Deferred.await(following);
      yield* Queue.take(detailReads);

      yield* Queue.offerAll(events, [undefined, undefined, undefined]);
      yield* Queue.takeN(received, 3);
      yield* TestClock.adjust("19 seconds");
      assert.equal(yield* Queue.size(detailReads), 0, "a host event was read before it settled");
      yield* TestClock.adjust("1 second");
      yield* Queue.take(detailReads);
      // A sweep waits for the change read in flight, then reads once itself.
      yield* reactor.sweep;
      assert.equal(yield* Queue.size(detailReads), 1, "the burst was read more than once");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
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
        const received = yield* Queue.unbounded<void>();
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
            followsChanges: () => Effect.succeed(true),
            changes: () =>
              Stream.fromEffectDrain(Deferred.succeed(following, undefined)).pipe(
                Stream.concat(
                  Stream.fromQueue(events).pipe(Stream.tap(() => Queue.offer(received, undefined))),
                ),
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
        // The clock moves only through the settle, so no sweep can be the one that reads the failure.
        yield* Queue.take(received);
        yield* TestClock.adjust("20 seconds");
        yield* Queue.take(detailReads);
        // Nothing new: this read must compare against the watch the last one recorded.
        yield* Queue.offer(events, undefined);
        yield* Queue.take(received);
        yield* TestClock.adjust("20 seconds");
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
  it.effect("gives the 64 feed slots only to pull requests whose host has an event feed", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, projectId } = yield* watchPullRequest("pr-watch-feed-cap", 1);
      const watch = (host: string, number: number) =>
        orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-feed-cap-${host}-${number}`),
          threadId,
          host,
          repository: "goat-si/goat",
          number,
          watching: true,
          link: { url: `https://${host}/goat-si/goat/pull/${number}`, source: "agent" },
        });
      for (let number = 2; number <= 65; number += 1) yield* watch("github.com", number);
      // Its key sorts before every github.com one.
      yield* watch("bitbucket.org", 1);
      const opened: Array<string> = [];
      const full = yield* Deferred.make<void>();
      const detailReads = yield* Queue.unbounded<void>();
      const reactor = yield* PullRequestWatchReactor.make.pipe(
        Effect.provide(
          fakeHost({
            projectId,
            number: 1,
            detailReads,
            followsChanges: (ref) => ref.host === "github.com",
            changes: (ref) => {
              opened.push(ref.host ?? "");
              if (opened.length === PullRequestEventFeeds.MAX_EVENT_FEEDS) {
                Deferred.doneUnsafe(full, Effect.void);
              }
              return Stream.never;
            },
          }),
        ),
      );
      yield* reactor.start();
      yield* Deferred.await(full);
      assert.deepEqual(
        opened.filter((host) => host !== "github.com"),
        [],
        "a host without an event feed took a feed slot",
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});

describe("pull request watch host event feeds", () => {
  it("follows at most 64 pull requests, the same ones whatever order the sweep found them in", () => {
    const candidates = Array.from(
      { length: 70 },
      (_, index) => [`github.com goat-si/goat#${String(index).padStart(3, "0")}`, index] as const,
    );
    const forward = PullRequestEventFeeds.feedsToFollow(candidates);
    const backward = PullRequestEventFeeds.feedsToFollow(candidates.toReversed());
    assert.equal(PullRequestEventFeeds.MAX_EVENT_FEEDS, 64);
    assert.deepEqual(
      [...forward.keys()],
      candidates.slice(0, 64).map(([key]) => key),
    );
    assert.deepEqual([...backward.keys()], [...forward.keys()]);
  });
});
