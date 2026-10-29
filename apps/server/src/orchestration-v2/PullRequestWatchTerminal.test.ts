import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  type PullRequestCheck,
  type PullRequestDetail,
  SourceControlProviderKind,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as PullRequestWatchReactor from "./PullRequestWatchReactor.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import {
  layerCheckpointStoreTest,
  layerGitWorkflowTest,
  layerPlatformTest,
  layerProjectServiceTest,
  layerServerConfig,
  layerTestProviderInstanceRegistry,
  modelSelection,
} from "./runtimeLayer.testkit.ts";

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

const NUMBER = 41;
const URL = `https://github.com/goat-si/goat/pull/${NUMBER}`;
const key = { host: "github.com", repository: "goat-si/goat", number: NUMBER };
const AT = "2026-10-29T00:00:00.000Z";
const failed = (name: string): PullRequestCheck => ({
  name,
  status: "failure",
  description: null,
  url: null,
});
const pending: PullRequestCheck = { name: "ci", status: "pending", description: null, url: null };

type HostState = Pick<
  PullRequestDetail,
  "state" | "headSha" | "checks" | "mergedAt" | "closedAt" | "viewer"
>;

const detailOf = (projectId: ProjectId, host: HostState): PullRequestDetail => ({
  provider: SourceControlProviderKind.make("github"),
  capabilities: {
    diff: true,
    comment: true,
    actions: [],
    mergeMethods: [],
    search: false,
    checksAlwaysReport: true,
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
  },
  viewerPermissions: {
    actions: [],
    comment: true,
    resolve: true,
    verdicts: [],
    requestReviewers: false,
  },
  projectId,
  projectTitle: "Watched",
  workspaceRoot: "/workspace/watched",
  repository: key.repository,
  number: NUMBER,
  title: "Watched pull request",
  body: "",
  url: URL,
  author: { login: "lane-agent", name: null, avatarUrl: null },
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  baseBranch: "dev",
  createdAt: AT,
  updatedAt: AT,
  reviewers: [],
  labels: [],
  mergeCapabilities: { merge: true, squash: true, rebase: true },
  ...host,
});

const openAt = (headSha: string, checks: ReadonlyArray<PullRequestCheck>): HostState => ({
  state: "open",
  headSha,
  checks,
  mergedAt: null,
  closedAt: null,
  viewer: "lane-agent",
});

/** A thread watching #41 and a reactor reading it from a host the test steers. */
const watchedThread = (name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`pr-terminal-${name}`);
    const projectId = ProjectId.make(`pr-terminal-${name}-project`);
    yield* Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
      projects.apply({
        sequence: 0,
        eventId: EventId.make(`seed:${projectId}`),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: AT,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId,
          title: "Watched",
          workspaceRoot: `/workspace/${name}`,
          defaultModelSelection: null,
          scripts: [],
          createdAt: AT,
          updatedAt: AT,
        },
      }),
    );
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`pr-terminal-${name}-create`),
      threadId,
      projectId,
      title: "Watched",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make(`pr-terminal-${name}-watch`),
      threadId,
      ...key,
      watching: true,
      link: { url: URL, source: "agent" },
    });
    const host = yield* Ref.make<HostState | "unreachable">(openAt("aaaa111", [pending]));
    const reads = yield* Ref.make(0);
    const activityBroken = yield* Ref.make(false);
    const duringRead = yield* Ref.make<Effect.Effect<void>>(Effect.void);
    const reactor = yield* PullRequestWatchReactor.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          ServerSettings.layerTest(),
          Layer.mock(PullRequestService.PullRequestService)({
            detail: () =>
              Effect.gen(function* () {
                yield* Ref.update(reads, (count) => count + 1);
                yield* Effect.flatten(Ref.getAndSet(duringRead, Effect.void));
                const state = yield* Ref.get(host);
                if (state === "unreachable") return yield* Effect.die("host unreachable");
                return detailOf(projectId, state);
              }),
            activity: () =>
              Effect.flatMap(Ref.get(activityBroken), (broken) =>
                broken
                  ? Effect.die("activity unreadable")
                  : Effect.succeed({
                      comments: [],
                      commentCount: 0,
                      commentsTruncated: false,
                      reviewThreads: [],
                      commits: [],
                    }),
              ),
          }),
        ),
      ),
    );
    const link = Effect.map(
      orchestrator.getThreadShell(threadId),
      (thread) => thread?.pullRequests?.[0],
    );
    const records = Effect.map(
      orchestrator.getThreadRecords(threadId, ["runs", "messages"]),
      ({ runs, messages }) => ({
        summaries: messages.flatMap((message) => message.notification?.summary ?? []),
        runs: runs.map((run) => run.status),
      }),
    );
    const snapshot = (state: "open" | "merged" | "closed") =>
      orchestrator.dispatch({
        type: "thread.pull-request-link.sync",
        commandId: CommandId.make(`pr-terminal-${name}-snapshot-${state}`),
        threadId,
        ...key,
        snapshot: {
          state,
          title: "Watched pull request",
          headBranch: "feature",
          baseBranch: "dev",
          isDraft: false,
          updatedAt: AT,
          syncedAt: AT,
        },
        stack: null,
      });
    return {
      orchestrator,
      threadId,
      projectId,
      host,
      reads,
      activityBroken,
      duringRead,
      reactor,
      link,
      records,
      snapshot,
    };
  });

const sweeps = (
  reactor: PullRequestWatchReactor.PullRequestWatchReactor["Service"],
  count: number,
) =>
  Effect.gen(function* () {
    for (let pass = 0; pass < count; pass += 1) {
      yield* reactor.sweep;
      yield* TestClock.adjust("2 minutes");
    }
  });

describe("a watch on a pull request that merged or closed", () => {
  it.effect("ends on a squash merge whose merge commit is not the watched head", () =>
    Effect.gen(function* () {
      const { host, reads, reactor, link, records } = yield* watchedThread("squash");
      yield* reactor.sweep;
      assert.strictEqual((yield* link)?.watch?.headSha, "aaaa111");
      // GitHub keeps headRefOid at the PR head; the squash commit on dev is another SHA.
      yield* Ref.set(host, { ...openAt("aaaa111", [pending]), state: "merged", mergedAt: AT });
      yield* TestClock.adjust("2 minutes");
      yield* reactor.sweep;
      assert.isUndefined((yield* link)?.watch);
      const readsAtEnd = yield* Ref.get(reads);
      yield* sweeps(reactor, 5);
      assert.strictEqual(yield* Ref.get(reads), readsAtEnd);
      assert.deepEqual(yield* records, { summaries: [], runs: [] });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("ends when another actor merges it and drops the wake it left queued", () =>
    Effect.gen(function* () {
      const { host, reactor, link, records, orchestrator, threadId } =
        yield* watchedThread("other-actor");
      yield* Ref.set(host, openAt("aaaa111", [failed("lint")]));
      yield* reactor.sweep;
      // Without a host fingerprint, a quiet pull request is read again after ten minutes.
      yield* TestClock.adjust("10 minutes");
      yield* Ref.set(host, openAt("bbbb222", [failed("test")]));
      yield* reactor.sweep;
      const before = yield* records;
      assert.deepEqual(before.summaries, ["#41: checks failed", "#41: checks failed"]);
      assert.strictEqual(before.runs.at(-1), "queued");
      // A coordinator or a person merged it: the viewer is not the merger, and the head is unchanged.
      yield* Ref.set(host, {
        ...openAt("bbbb222", [failed("test")]),
        state: "merged",
        mergedAt: AT,
        viewer: "someone-else",
      });
      yield* TestClock.adjust("10 minutes");
      yield* reactor.sweep;
      assert.isUndefined((yield* link)?.watch);
      const { runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
      assert.strictEqual(runs.at(-1)?.status, "cancelled");
      yield* sweeps(reactor, 3);
      assert.strictEqual((yield* records).summaries.length, 2);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each([
    ["closed without merging", "cccc333"],
    ["closed after its head branch was deleted", null],
  ] as const)("ends with one notice when %s", ([, headSha]) =>
    Effect.gen(function* () {
      const { host, reads, reactor, link, records } = yield* watchedThread(
        headSha === null ? "head-deleted" : "closed",
      );
      yield* reactor.sweep;
      const { headSha: _open, ...open } = openAt("aaaa111", [pending]);
      // A deleted head leaves the host without a head commit to report.
      yield* Ref.set(host, {
        ...open,
        ...(headSha === null ? {} : { headSha }),
        state: "closed",
        closedAt: AT,
      });
      yield* TestClock.adjust("2 minutes");
      yield* reactor.sweep;
      assert.isUndefined((yield* link)?.watch);
      const readsAtEnd = yield* Ref.get(reads);
      yield* sweeps(reactor, 5);
      assert.strictEqual(yield* Ref.get(reads), readsAtEnd);
      assert.deepEqual((yield* records).summaries, ["#41: closed, stopped watching"]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("ends on a merge the detail read reports while the activity read fails", () =>
    Effect.gen(function* () {
      const { host, activityBroken, reactor, link, records } = yield* watchedThread("activity");
      yield* Ref.set(host, { ...openAt("aaaa111", [pending]), state: "merged", mergedAt: AT });
      yield* Ref.set(activityBroken, true);
      yield* reactor.sweep;
      assert.isUndefined((yield* link)?.watch);
      assert.deepEqual(yield* records, { summaries: [], runs: [] });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("never wakes for news read just before the pull request merged", () =>
    Effect.gen(function* () {
      const { host, duringRead, reactor, link, records, snapshot } =
        yield* watchedThread("merged-mid-read");
      yield* reactor.sweep;
      yield* snapshot("open");
      // The host answers with a failure while the merge lands and the link records it.
      yield* Ref.set(host, openAt("aaaa111", [failed("lint")]));
      yield* Ref.set(duringRead, Effect.orDie(snapshot("merged")));
      yield* TestClock.adjust("2 minutes");
      yield* reactor.sweep;
      assert.deepEqual(yield* records, { summaries: [], runs: [] });
      // The next sweep ends the watch from the merged link without reading the host.
      yield* TestClock.adjust("2 minutes");
      yield* reactor.sweep;
      assert.isUndefined((yield* link)?.watch);
      assert.deepEqual(yield* records, { summaries: [], runs: [] });
    }).pipe(Effect.provide(layerTest)),
  );
});

describe("a watch that cannot read its pull request", () => {
  it.effect("backs off between failed reads, then ends with a reason", () =>
    Effect.gen(function* () {
      const { host, reads, reactor, link, records } = yield* watchedThread("backoff");
      yield* Ref.set(host, "unreachable");
      // Eight sweeps two minutes apart: without backoff, each one reads the host again.
      yield* sweeps(reactor, 8);
      assert.isBelow(yield* Ref.get(reads), 5);
      assert.isDefined((yield* link)?.watch);
      yield* sweeps(reactor, 120);
      assert.isUndefined((yield* link)?.watch);
      assert.deepEqual((yield* records).summaries, ["#41: stopped watching, could not read it"]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("a watch started again reads at once and gets its own failure limit", () =>
    Effect.gen(function* () {
      const { host, reads, reactor, link, records, orchestrator, threadId } =
        yield* watchedThread("rewatch");
      yield* Ref.set(host, "unreachable");
      for (let pass = 0; pass < 60 && (yield* Ref.get(reads)) < 7; pass += 1) {
        yield* reactor.sweep;
        yield* TestClock.adjust("2 minutes");
      }
      assert.strictEqual(yield* Ref.get(reads), 7);
      for (const watching of [false, true])
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-terminal-rewatch-${watching}`),
          threadId,
          ...key,
          watching,
          link: { url: URL, source: "agent" },
        });
      yield* reactor.sweep;
      assert.strictEqual(yield* Ref.get(reads), 8);
      assert.isDefined((yield* link)?.watch);
      assert.deepEqual((yield* records).summaries, []);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("an older watch still reaches its limit when another thread starts watching", () =>
    Effect.gen(function* () {
      const { host, reads, reactor, link, records, orchestrator, projectId } =
        yield* watchedThread("two-watches");
      yield* Ref.set(host, "unreachable");
      for (let pass = 0; pass < 60 && (yield* Ref.get(reads)) < 7; pass += 1) {
        yield* reactor.sweep;
        yield* TestClock.adjust("2 minutes");
      }
      const laterId = ThreadId.make("pr-terminal-two-watches-later");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-terminal-two-watches-later-create"),
        threadId: laterId,
        projectId,
        title: "Watching later",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-terminal-two-watches-later-watch"),
        threadId: laterId,
        ...key,
        watching: true,
        link: { url: URL, source: "agent" },
      });
      yield* reactor.sweep;
      assert.strictEqual(yield* Ref.get(reads), 8);
      assert.isUndefined((yield* link)?.watch);
      assert.deepEqual((yield* records).summaries, ["#41: stopped watching, could not read it"]);
      const later = yield* orchestrator.getThreadShell(laterId);
      assert.isDefined(later?.pullRequests?.[0]?.watch);
    }).pipe(Effect.provide(layerTest)),
  );
});
