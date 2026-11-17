import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CommandId, ProjectId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
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
  seedProject,
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

/** One idle thread watching each of \`numbers\`. */
const threadWatching = Effect.fn("test.threadWatching")(function* (
  name: string,
  numbers: ReadonlyArray<number>,
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
  for (const number of numbers)
    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make(`${name}-watch-${number}`),
      threadId,
      host: "github.com",
      repository: "goat-si/goat",
      number,
      watching: true,
      link: { url: `https://github.com/goat-si/goat/pull/${number}`, source: "agent" },
    });
  return { orchestrator, threadId, projectId };
});

/** A host where every watched pull request has a new comment from a person in each round. */
const hostWithNewComments = (
  projectId: ProjectId,
  options: {
    readonly round?: () => number;
    readonly onRead?: (number: number) => Effect.Effect<void>;
  } = {},
) =>
  Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    ServerSettings.layerTest(),
    Layer.mock(PullRequestService.PullRequestService)({
      detail: (read) =>
        (options.onRead?.(read.number) ?? Effect.void).pipe(
          Effect.as(
            watchedPullRequestDetail({
              projectId,
              number: read.number,
              at: "2026-10-02T12:00:00.000Z",
            }),
          ),
        ),
      activity: (read) =>
        Effect.sync(() => ({
          comments: [
            {
              id: `comment-${read.number}-${options.round?.() ?? 0}`,
              kind: "issue-comment",
              author: { login: "alice", name: null, avatarUrl: null },
              body: `Please rename the helper in #${read.number} (round ${options.round?.() ?? 0}).`,
              createdAt: `2026-10-02T12:0${options.round?.() ?? 0}:00.000Z`,
              url: null,
              path: null,
              reviewState: null,
            },
          ],
          commentCount: 1,
          commentsTruncated: false,
          reviewThreads: [],
          commits: [],
        })),
      watchFingerprint: () =>
        Effect.sync(() => {
          const round = String(options.round?.() ?? 0);
          return { status: round, remarks: round };
        }),
      invalidate: () => Effect.void,
      changes: () => Stream.never,
      followsChanges: () => Effect.succeed(false),
    }),
  );

describe("pull request watch wakes from one pass", () => {
  it.effect(
    "an idle thread whose two watched pull requests changed in one pass starts one turn naming both",
    () =>
      Effect.gen(function* () {
        const { orchestrator, threadId, projectId } = yield* threadWatching(
          "pr-batch-idle",
          [21, 22],
        );
        const reactor = yield* PullRequestWatchReactor.make.pipe(
          Effect.provide(hostWithNewComments(projectId)),
        );
        yield* reactor.sweep;
        const { runs, messages } = yield* orchestrator.getThreadRecords(threadId, [
          "runs",
          "messages",
        ]);
        assert.equal(runs.length, 1, "the pass woke the thread more than once");
        const text = messages.find((message) => message.id === runs[0]?.userMessageId)?.text ?? "";
        assert.include(text, "Please rename the helper in #21 (round 0).");
        assert.include(text, "Please rename the helper in #22 (round 0).");
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "a watch that ends during the read leaves the other pull request's wake to go alone",
    () =>
      Effect.gen(function* () {
        const { orchestrator, threadId, projectId } = yield* threadWatching(
          "pr-batch-ended",
          [21, 22],
        );
        const unwatch22 = orchestrator
          .dispatch({
            type: "thread.pull-request.watch",
            commandId: CommandId.make("pr-batch-ended-unwatch-22"),
            threadId,
            host: "github.com",
            repository: "goat-si/goat",
            number: 22,
            watching: false,
          })
          .pipe(Effect.orDie, Effect.asVoid);
        const reactor = yield* PullRequestWatchReactor.make.pipe(
          Effect.provide(
            hostWithNewComments(projectId, {
              onRead: (number) => (number === 22 ? unwatch22 : Effect.void),
            }),
          ),
        );
        yield* reactor.sweep;
        const { runs, messages } = yield* orchestrator.getThreadRecords(threadId, [
          "runs",
          "messages",
        ]);
        const texts = runs.map(
          (run) => messages.find((message) => message.id === run.userMessageId)?.text ?? "",
        );
        assert.equal(texts.length, 1);
        assert.include(texts[0], "#21 (round 0)");
        assert.notInclude(texts[0], "#22");
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("a busy thread folds a later pass's wakes into its queued digest one notice each", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, projectId } = yield* threadWatching(
        "pr-batch-busy",
        [21, 22],
      );
      let round = 0;
      const reactor = yield* PullRequestWatchReactor.make.pipe(
        Effect.provide(hostWithNewComments(projectId, { round: () => round })),
      );
      // The first pass starts a turn, the second queues a digest, the third joins it.
      for (round = 0; round < 3; round++) yield* reactor.sweep;
      const { runs, messages } = yield* orchestrator.getThreadRecords(threadId, [
        "runs",
        "messages",
      ]);
      const queued = runs.filter((run) => run.status === "queued");
      assert.equal(queued.length, 1);
      const text = messages.find((message) => message.id === queued[0]?.userMessageId)?.text ?? "";
      assert.include(text, '<notices count="4">');
      assert.equal(text.split("<notices").length, 2, "the digest nested another digest");
      for (const n of [21, 22]) for (const r of [1, 2]) assert.include(text, `#${n} (round ${r})`);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
