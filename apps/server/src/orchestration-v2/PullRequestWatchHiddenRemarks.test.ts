import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type ModelSelection,
  ProjectId,
  type PullRequestComment,
  type PullRequestDetail,
  SourceControlProviderKind,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as PullRequestWatchReactor from "./PullRequestWatchReactor.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
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

const key = { host: "github.com", repository: "goat-si/goat", number: 7 };
const url = "https://github.com/goat-si/goat/pull/7";

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

describe("pull request watch hidden remarks", () => {
  it.effect("a hidden reply still completes the thread's count, so the watch wakes once", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("pr-wakes-hidden-reply");
      const projectId = ProjectId.make("pr-wakes-hidden-reply-project");
      const at = "2026-10-23T00:00:00.000Z";
      yield* seedProject({
        projectId,
        title: "Watched",
        workspaceRoot: process.cwd(),
        defaultModelSelection: modelSelection,
        createdAt: at,
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-wakes-hidden-reply-create"),
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
        commandId: CommandId.make("pr-wakes-hidden-reply-watch"),
        threadId,
        ...key,
        watching: true,
        link: { url, source: "agent" },
      });
      const detail: PullRequestDetail = {
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
        workspaceRoot: process.cwd(),
        repository: key.repository,
        number: key.number,
        title: "Watched pull request",
        body: "",
        url,
        author: { login: "agent-user", name: null, avatarUrl: null },
        state: "open",
        isDraft: false,
        mergeability: "mergeable",
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        headBranch: "feature",
        headSha: "abc1234def",
        baseBranch: "main",
        createdAt: at,
        updatedAt: at,
        mergedAt: null,
        closedAt: null,
        reviewers: [],
        labels: [],
        checks: [{ name: "lint", status: "failure", description: null, url: null }],
        mergeCapabilities: { merge: true, squash: true, rebase: true },
        viewer: "agent-user",
      };
      const remark: PullRequestComment = {
        id: "review-1",
        kind: "review-comment",
        author: { login: "reviewer", name: null, avatarUrl: null },
        body: "One more thing.",
        createdAt: "2999-01-01T00:00:03.000Z",
        url: null,
        path: "src/index.ts",
        reviewState: null,
      };
      const firstTen = Array.from({ length: 10 }, (_, index) => ({
        ...remark,
        id: `old-${index}`,
        createdAt: "1900-01-01T00:00:00.000Z",
      }));
      const reactor = yield* PullRequestWatchReactor.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeCrypto.layer,
            ServerSettings.layerTest(),
            Layer.mock(PullRequestService.PullRequestService)({
              detail: () => Effect.succeed(detail),
              activity: () =>
                Effect.succeed({
                  comments: [],
                  commentCount: 0,
                  commentsTruncated: false,
                  reviewThreads: [
                    {
                      id: "review-thread",
                      path: "src/index.ts",
                      line: 1,
                      side: "right",
                      isResolved: false,
                      isOutdated: false,
                      comments: firstTen,
                      commentCount: 13,
                      nextCommentsCursor: "after-10",
                    },
                  ],
                  commits: [],
                }),
              threadComments: () =>
                Effect.succeed({
                  comments: [
                    { ...remark, id: "reply-11", createdAt: "2999-01-01T00:00:01.000Z" },
                    { ...remark, id: "reply-12", createdAt: "2999-01-01T00:00:02.000Z" },
                  ],
                  nextCursor: null,
                  hiddenCount: 1,
                }),
            }),
          ),
        ),
      );
      yield* reactor.sweep;
      const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
      expect(messages.map((message) => message.notification?.summary)).toEqual([
        "#7: checks failed, new comments",
      ]);
    }).pipe(Effect.provide(layerTest)),
  );
});
