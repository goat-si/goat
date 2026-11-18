import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  type PullRequestCheck,
  type PullRequestComment,
  ThreadId,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

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
  Layer.provideMerge(layerServerConfig),
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
  sharedProjectId?: ProjectId,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadId = ThreadId.make(`${name}-thread`);
  const projectId = sharedProjectId ?? ProjectId.make(`${name}-project`);
  if (sharedProjectId === undefined) {
    yield* seedProject({
      projectId,
      title: name,
      workspaceRoot: `/workspace/${name}`,
      defaultModelSelection: null,
      createdAt: "2026-10-01T00:00:00.000Z",
    });
  }
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

  it.effect(
    "a merge recorded during one pull request's read leaves the other's wake to go alone",
    () =>
      Effect.gen(function* () {
        const { orchestrator, threadId, projectId } = yield* threadWatching(
          "pr-batch-merged",
          [21, 22],
        );
        // The link still holds its watch, so only the mute check can refuse #22's news.
        const merge22 = orchestrator
          .dispatch({
            type: "thread.pull-request-link.sync",
            commandId: CommandId.make("pr-batch-merged-22"),
            threadId,
            host: "github.com",
            repository: "goat-si/goat",
            number: 22,
            snapshot: {
              state: "merged",
              title: "Watched pull request",
              headBranch: "feature",
              baseBranch: "main",
              isDraft: false,
              updatedAt: "2026-10-02T12:00:00.000Z",
              syncedAt: "2026-10-02T12:00:00.000Z",
            },
            stack: null,
          })
          .pipe(Effect.orDie, Effect.asVoid);
        const reactor = yield* PullRequestWatchReactor.make.pipe(
          Effect.provide(
            hostWithNewComments(projectId, {
              onRead: (number) => (number === 22 ? merge22 : Effect.void),
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

describe("watched pull request checks", () => {
  it.effect(
    "records when a watched PR's checks finish, unless a push cleared that during the read",
    () =>
      Effect.gen(function* () {
        // Two watches, as with a stack, so news on both wakes the thread once for both.
        const { orchestrator, threadId, projectId } = yield* threadWatching(
          "pr-watch-quiet",
          [17, 18],
        );
        let e2e: PullRequestCheck["status"] = "pending";
        let comments: ReadonlyArray<PullRequestComment> = [];
        let gate: {
          readonly started: Deferred.Deferred<void>;
          readonly release: Deferred.Deferred<void>;
        } | null = null;
        const host = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          ServerSettings.layerTest(),
          Layer.mock(PullRequestService.PullRequestService)({
            detail: (input) =>
              Effect.gen(function* () {
                if (gate !== null) {
                  yield* Deferred.succeed(gate.started, undefined);
                  yield* Deferred.await(gate.release);
                }
                return {
                  ...watchedPullRequestDetail({
                    projectId,
                    number: input.number,
                    at: "2026-10-02T12:00:00.000Z",
                  }),
                  checks: [
                    { name: "test", status: "failure" as const, description: null, url: null },
                    { name: "e2e", status: e2e, description: null, url: null },
                  ],
                };
              }),
            activity: () =>
              Effect.sync(() => ({
                comments,
                commentCount: comments.length,
                commentsTruncated: false,
                reviewThreads: [],
                commits: [],
              })),
            watchFingerprint: () => Effect.succeed(null),
            invalidate: () => Effect.void,
            changes: () => Stream.never,
            followsChanges: () => Effect.succeed(false),
          }),
        );
        const summaries = Effect.map(
          orchestrator.getThreadRecords(threadId, ["messages"]),
          ({ messages }) => messages.flatMap((message) => message.notification?.summary ?? []),
        );
        const checksPending = Effect.map(orchestrator.getThreadShell(threadId), (thread) => {
          const answers = (thread?.pullRequests ?? []).map((link) => link.watch?.checksPending);
          assert.lengthOf(answers, 2);
          assert.strictEqual(answers[0], answers[1]);
          return answers[0];
        });

        const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
        yield* reactor.sweep;
        assert.deepEqual(yield* summaries, []);
        assert.isTrue(yield* checksPending);
        const reopen = (id: string) =>
          orchestrator.dispatch({
            type: "thread.pull-request-watch.checks-reopen",
            commandId: CommandId.make(`pr-watch-quiet-${id}`),
            threadId,
          });
        // A push forgets a running answer too, so a read begun before it cannot settle it.
        yield* reopen("push-pending");
        assert.isUndefined(yield* checksPending);

        e2e = "success";
        yield* TestClock.adjust("10 minutes");
        yield* reactor.sweep;
        assert.deepEqual(yield* summaries, []);
        assert.isFalse(yield* checksPending);

        // A push clears the answer while a read with news is in flight. That read's answer is the
        // old head's, so the answer stays cleared while its news still wakes the agent.
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        gate = { started, release };
        comments = [
          {
            id: "comment-1",
            kind: "issue-comment",
            author: { login: "reviewer", name: null, avatarUrl: null },
            body: "Looks good once CI passes.",
            createdAt: "2999-01-01T00:00:00.000Z",
            url: null,
            path: null,
            reviewState: null,
          },
        ];
        yield* TestClock.adjust("10 minutes");
        const inFlight = yield* reactor.sweep.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(started);
        yield* reopen("push");
        // Another push before the watch read again finds nothing to clear, which is fine.
        yield* reopen("push-again");
        gate = null;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(inFlight);
        assert.lengthOf(yield* summaries, 1);
        assert.isUndefined(yield* checksPending);

        // The next sweep reads it again though nothing on the host changed.
        yield* TestClock.adjust("2 minutes");
        yield* reactor.sweep;
        assert.isFalse(yield* checksPending);
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});

it.effect("delivers every wake once across passes when watches exceed the sweep budget", () =>
  Effect.gen(function* () {
    const numbers = Array.from({ length: 65 }, (_, index) => index + 1);
    const { orchestrator, threadId, projectId } = yield* threadWatching("pr-batch-paged", numbers);
    const reads: Array<number> = [];
    const reactor = yield* PullRequestWatchReactor.make.pipe(
      Effect.provide(
        hostWithNewComments(projectId, {
          onRead: (number) =>
            Effect.sync(() => {
              reads.push(number);
            }),
        }),
      ),
    );
    const wakes = Effect.gen(function* () {
      const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
      return messages
        .flatMap(({ text }) => Array.from(text.matchAll(/helper in #(\d+) \(round 0\)/g)))
        .map((match) => Number(match[1]))
        .sort((left, right) => left - right);
    });

    yield* reactor.sweep;
    assert.lengthOf(yield* wakes, 64, "the first pass must leave one watch for its continuation");
    assert.lengthOf(reads, 64);
    const thread = yield* orchestrator.getThreadShell(threadId);
    const deferred = thread?.pullRequests?.filter((link) => !reads.includes(link.number)) ?? [];
    assert.lengthOf(deferred, 1);
    assert.equal(deferred[0]?.watch?.awaitingBaseline, "all");
    yield* reactor.sweep;
    assert.deepEqual(yield* wakes, numbers);
    assert.deepEqual(
      reads.toSorted((left, right) => left - right),
      numbers,
    );
    yield* reactor.sweep;
    assert.deepEqual(yield* wakes, numbers, "a later sweep must not repeat a delivered wake");
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("continues through a pull request group that grows and shrinks across 64 watches", () =>
  Effect.gen(function* () {
    const {
      orchestrator,
      projectId,
      threadId: later,
    } = yield* threadWatching("watch-churn-later", [22]);
    const permanent = Array.from({ length: 64 }, (_, index) => String(index).padStart(2, "0"));
    const watchers = yield* Effect.forEach(permanent, (id) =>
      threadWatching(`watch-churn-peer-${id}`, [21], projectId),
    );
    const { threadId: temporary } = yield* threadWatching("watch-churn-first", [21], projectId);
    const setTemporary = (watching: boolean, round: number) =>
      orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make(`watch-churn-temporary-${watching}-${round}`),
        threadId: temporary,
        host: "github.com",
        repository: "goat-si/goat",
        number: 21,
        watching,
      });
    const notices = (id: ThreadId) =>
      orchestrator
        .getThreadRecords(id, ["messages"])
        .pipe(
          Effect.map(({ messages }) =>
            messages.flatMap(({ text }) => text.match(/helper in #\d+ \(round \d+\)/g) ?? []),
          ),
        );
    const last = watchers[63]!.threadId;
    const reads: Array<number> = [];
    let round = 0;
    const reactor = yield* PullRequestWatchReactor.make.pipe(
      Effect.provide(
        hostWithNewComments(projectId, {
          round: () => round,
          onRead: (number) => Effect.sync(() => void reads.push(number)),
        }),
      ),
    );

    for (round = 0; round < 2; round++) {
      if (round > 0) yield* setTemporary(true, round);
      reads.length = 0;
      yield* reactor.sweep;
      assert.deepEqual(reads, [21], "the first page shares one read across its 64 targets");
      assert.lengthOf(yield* notices(last), round);
      yield* setTemporary(false, round);
      yield* reactor.sweep;
      assert.include(yield* notices(last), `helper in #21 (round ${round})`);
      assert.include(yield* notices(later), `helper in #22 (round ${round})`);
      assert.deepEqual(reads.slice(1).sort(), [21, 22]);
    }
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("resumes the last completed watch page after a restart and clears it at cycle end", () =>
  Effect.gen(function* () {
    const numbers = Array.from({ length: 65 }, (_, index) => index + 1);
    const { projectId } = yield* threadWatching("pr-batch-restart", numbers);
    const reads: Array<number> = [];
    const host = hostWithNewComments(projectId, {
      onRead: (number) => Effect.sync(() => void reads.push(number)),
    });
    const sweepFromNewReactor = Effect.gen(function* () {
      const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
      yield* reactor.sweep;
    });

    yield* sweepFromNewReactor;
    assert.lengthOf(reads, 64);
    const firstPage = new Set(reads);
    const remaining = numbers.filter((number) => !firstPage.has(number));
    assert.lengthOf(remaining, 1);

    reads.length = 0;
    yield* sweepFromNewReactor;
    assert.deepEqual(reads, remaining);

    reads.length = 0;
    yield* sweepFromNewReactor;
    assert.deepEqual(new Set(reads), firstPage);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
