import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand as OrchestrationCommand,
  PullRequestOperationError,
  type OrchestrationProjectShell,
  type PullRequestRef,
  type PullRequestChecks,
  type PullRequestReviewGuideResult,
  type ThreadPullRequestLink,
  SourceControlProviderKind,
} from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import {
  type PullRequestTestThread,
  v2PullRequestThread,
} from "../../../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as PullRequestService from "../../../pullRequest/PullRequestService.ts";
import * as PullRequestReviewGuideService from "../../../pullRequest/PullRequestReviewGuideService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import { listThreadPullRequests } from "./handlers.ts";
import * as PullRequestsHandlers from "./handlers.ts";
import { PullRequestsToolkit } from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: {
    threadId: THREAD_ID,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

function makeProject(
  repositoryIdentity: OrchestrationProjectShell["repositoryIdentity"] = {
    canonicalKey: "github.com/sample-tools/goat",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:Sample-Tools/Goat.git",
    },
    provider: SourceControlProviderKind.make("github"),
    displayName: "Sample-Tools/Goat",
    owner: "Sample-Tools",
    name: "Goat",
  },
): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    title: "Project",
    workspaceRoot: "/workspace/project",
    defaultModelSelection: null,
    scripts: [],
    repositoryIdentity,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function makeThread(pullRequests: ReadonlyArray<ThreadPullRequestLink>): PullRequestTestThread {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    latestUserMessageAt: "2026-08-20T00:00:00.000Z",
  };
}

function makeLink(
  number: number,
  overrides: Partial<ThreadPullRequestLink> & {
    readonly headBranch?: string;
    readonly baseBranch?: string;
  } = {},
): ThreadPullRequestLink {
  const { headBranch, baseBranch, ...rest } = overrides;
  return {
    host: "github.com",
    repository: "sample-tools/goat",
    number,
    url: `https://github.com/sample-tools/goat/pull/${number}`,
    source: "manual",
    linkedAt: "2026-08-10T00:00:00.000Z",
    snapshot:
      headBranch === undefined
        ? null
        : {
            state: "open",
            title: `PR ${number}`,
            headBranch,
            baseBranch: baseBranch ?? "main",
            isDraft: false,
            updatedAt: null,
            syncedAt: "2026-08-27T00:00:00.000Z",
          },
    stack: null,
    ...rest,
  };
}

interface HarnessOptions {
  readonly thread?: PullRequestTestThread | null;
  readonly project?: OrchestrationProjectShell | null;
  readonly reject?: (command: OrchestrationCommand) => string | null;
  readonly projects?: ReadonlyArray<OrchestrationProjectShell>;
  readonly generate?: (
    input: PullRequestRef,
  ) => Effect.Effect<
    PullRequestReviewGuideResult & { started: boolean },
    PullRequestOperationError
  >;
  readonly checks?: (
    input: PullRequestRef,
  ) => Effect.Effect<PullRequestChecks | null, PullRequestOperationError>;
  /** Further service answers a test needs; the doubles above record their refs in reads. */
  readonly service?: Partial<PullRequestService.PullRequestService["Service"]>;
}

const NO_GUIDE: PullRequestReviewGuideResult = { guide: null, run: null, currentHeadSha: "head-1" };

const makeHarness = Effect.fn("makePullRequestsToolkitHarness")(function* (
  options: HarnessOptions = {},
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const guideRequests = yield* Ref.make<ReadonlyArray<PullRequestRef>>([]);
  const reads = yield* Ref.make<ReadonlyArray<PullRequestRef>>([]);
  const thread = options.thread === undefined ? makeThread([]) : options.thread;
  const project = options.project === undefined ? makeProject() : options.project;
  const dispatch: Orchestrator.OrchestratorV2Shape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const rejection = options.reject?.(command) ?? null;
      if (rejection !== null)
        return yield* new Orchestrator.OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: rejection,
        });
      yield* Ref.update(commands, (recorded) => [...recorded, command]);
      return { sequence: 1, storedEvents: [] };
    });
  const layerDependencies = Layer.mergeAll(
    Layer.mock(ProjectService.ProjectService)({
      getShell: () => Effect.succeed(Option.fromNullishOr(project)),
      listShells: () => Effect.succeed(options.projects ?? (project ? [project] : [])),
    }),
    Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({
      get: () => Effect.succeed(NO_GUIDE),
      generate: (input) =>
        Ref.update(guideRequests, (recorded) => [...recorded, input]).pipe(
          Effect.andThen(
            options.generate?.(input) ??
              Effect.succeed({
                ...NO_GUIDE,
                run: {
                  _tag: "Running" as const,
                  headSha: "head-1",
                  startedAt: "2026-10-11T00:00:00.000Z",
                },
                started: true,
              }),
          ),
        ),
    }),
    Layer.mock(PullRequestService.PullRequestService)({
      ...options.service,
      detail: (input) =>
        Ref.update(reads, (recorded) => [...recorded, input]).pipe(
          Effect.andThen(
            Effect.fail(new PullRequestOperationError({ operation: "detail", detail: "offline" })),
          ),
        ),
      checks: (input) =>
        Ref.update(reads, (recorded) => [...recorded, input]).pipe(
          Effect.andThen(options.checks?.(input) ?? Effect.succeed(null)),
        ),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: (id) =>
        Effect.succeed(id === THREAD_ID && thread ? v2PullRequestThread(thread) : null),
      dispatch,
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
    McpToolAccessTestkit.liveThreadsLayer,
  );
  const toolkit = yield* PullRequestsToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(PullRequestsHandlers.layer).pipe(
        Layer.provide(layerDependencies),
      ),
    ),
  );
  const call = <Name extends keyof typeof PullRequestsToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["pull-requests"],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof PullRequestsToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
      Effect.provide(layerDependencies),
    );
  return { commands, guideRequests, reads, call };
});

describe("pull request toolkit handlers", () => {
  it.effect.each([false, true])(
    "asks a delegated child to report its PR, including an already-linked PR (%s)",
    (alreadyLinked) =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          thread: {
            ...makeThread(alreadyLinked ? [makeLink(1)] : []),
            lineage: {
              rootThreadId: ThreadId.make("parent"),
              parentThreadId: ThreadId.make("parent"),
              relationshipToParent: "subagent",
            },
          },
        });
        expect(
          yield* harness.call("link_pull_request", { repository: "sample-tools/goat", number: 1 }),
        ).toMatchObject({
          alreadyLinked,
          next: "End your reply with: PR <full URL>, head <SHA>, checks and reviews <state>.",
        });
        expect(yield* Ref.get(harness.commands)).toHaveLength(alreadyLinked ? 0 : 1);
      }),
  );

  it.effect("refuses a credential without the pull-requests capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("list_thread_pull_requests", {}, ["preview"])
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "pull-requests",
        threadId: THREAD_ID,
      });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("links by URL with source agent on the token's thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("link_pull_request", {
        url: "https://github.com/Sample-Tools/Goat/pull/123/files",
      });
      expect(result).toEqual({
        host: "github.com",
        repository: "sample-tools/goat",
        number: 123,
        url: "https://github.com/Sample-Tools/Goat/pull/123/files",
        alreadyLinked: false,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.pull-request.link",
          threadId: THREAD_ID,
          host: "github.com",
          repository: "sample-tools/goat",
          number: 123,
          source: "agent",
        },
      ]);
    }),
  );

  it.effect("watching an unlinked pull request links it first", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("watch_pull_request", {
        url: "https://github.com/sample-tools/goat/pull/9",
      });
      expect(result).toMatchObject({ number: 9, watching: false, wasWatching: false });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.pull-request.watch",
          number: 9,
          watching: true,
          link: { url: "https://github.com/sample-tools/goat/pull/9", source: "agent" },
        },
      ]);
    }),
  );

  it.effect("refuses to watch a merged pull request and stops an existing watch", () =>
    Effect.gen(function* () {
      const watch = {
        startedAt: "2026-08-20T00:00:00.000Z",
        headSha: null,
        failedChecks: [],
        passed: false,
        passedChecks: [],
        remarksThrough: "2026-08-20T00:00:00.000Z",
        remarkIds: [],
        conflicting: false,
        wakes: 0,
      };
      const merged = makeLink(1, { headBranch: "done" });
      const harness = yield* makeHarness({
        thread: makeThread([
          { ...merged, snapshot: merged.snapshot && { ...merged.snapshot, state: "merged" } },
          makeLink(2, { headBranch: "idle" }),
          makeLink(3, { headBranch: "watched", watch }),
        ]),
      });
      const error = yield* harness
        .call("watch_pull_request", { repository: "sample-tools/goat", number: 1 })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "PullRequestNotOpenError", state: "merged" });
      expect(
        yield* harness.call("unwatch_pull_request", { repository: "sample-tools/goat", number: 3 }),
      ).toMatchObject({ wasWatching: true });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.watch", number: 3, watching: false },
      ]);
    }),
  );

  it.effect("watches a pull request saved as closed, since it may have reopened", () =>
    Effect.gen(function* () {
      const closed = makeLink(1, { headBranch: "closed" });
      const harness = yield* makeHarness({
        thread: makeThread([
          { ...closed, snapshot: closed.snapshot && { ...closed.snapshot, state: "closed" } },
        ]),
      });
      yield* harness.call("watch_pull_request", { repository: "sample-tools/goat", number: 1 });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.watch", number: 1, watching: true },
      ]);
    }),
  );

  it.effect("refuses a watch from a subagent thread, whose parent owns the pull request", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: {
          ...makeThread([makeLink(1, { headBranch: "feature" })]),
          lineage: {
            rootThreadId: ThreadId.make("parent"),
            parentThreadId: ThreadId.make("parent"),
            relationshipToParent: "subagent",
          },
        },
      });
      const error = yield* harness
        .call("watch_pull_request", { repository: "sample-tools/goat", number: 1 })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "PullRequestWatchFromSubagentError" });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("canonicalizes GitCafe links independently of the thread's project host", () =>
    Effect.gen(function* () {
      for (const host of ["git.cafe", "staging.git.cafe"]) {
        for (const project of [makeProject(), makeProject(null)]) {
          for (const target of [
            { host, repository: "Goat-SI/Goat", number: 21353 },
            { url: `https://${host}/Goat-SI/Goat/pull/21353` },
            { url: `https://${host}/Goat-SI/Goat/pulls/21353` },
          ]) {
            const harness = yield* makeHarness({ project });
            const result = yield* harness.call("link_pull_request", target);
            const url = `https://${host}/goat-si/goat/pulls/21353`;
            expect(result).toMatchObject({
              host,
              repository: "goat-si/goat",
              number: 21353,
              url,
            });
            expect(yield* Ref.get(harness.commands)).toMatchObject([
              {
                type: "thread.pull-request.link",
                host,
                repository: "goat-si/goat",
                number: 21353,
                url,
              },
            ]);
          }
        }
      }
    }),
  );

  it.effect("builds the URL in the project host's own shape", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        project: makeProject({
          canonicalKey: "gitlab.com/group/sub/project",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "git@gitlab.com:group/sub/project.git",
          },
          provider: SourceControlProviderKind.make("gitlab"),
          displayName: "group/sub/project",
        }),
      });
      const result = yield* harness.call("link_pull_request", {
        repository: "group/sub/project",
        number: 42,
      });
      expect(result.url).toBe("https://gitlab.com/group/sub/project/-/merge_requests/42");
      expect(result.host).toBe("gitlab.com");
      const other = yield* harness.call("link_pull_request", {
        host: "gitlab.example.test",
        repository: "team/repo",
        number: 7,
      });
      expect(other.url).toBe("https://gitlab.example.test/team/repo/-/merge_requests/7");
      const onGitHub = yield* harness.call("link_pull_request", {
        host: "github.com",
        repository: "acme/web",
        number: 9,
      });
      expect(onGitHub.url).toBe("https://github.com/acme/web/pull/9");
    }),
  );

  it.effect("links a URL but not a bare number when the project's host is unknown", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        project: makeProject({
          canonicalKey: "scm.example.test/tfs/collection/project/_git/repo",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "http://dummy:secret@scm.example.test:8080/tfs/Collection/Project/_git/Repo",
          },
          provider: SourceControlProviderKind.make("unknown"),
          displayName: "tfs/collection/project/_git/repo",
        }),
      });
      const error = yield* harness
        .call("link_pull_request", { repository: "tfs/Collection/Project/_git/Repo", number: 124 })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "PullRequestUrlUnavailableError" });

      const supplied = "https://scm.example.test/tfs/Collection/Project/_git/Repo/pullrequest/123";
      const fromUrl = yield* harness.call("link_pull_request", { url: supplied });
      expect(fromUrl).toEqual({
        host: "scm.example.test",
        repository: "tfs/collection/project/_git/repo",
        number: 123,
        url: supplied,
        alreadyLinked: false,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.link", number: 123, url: supplied },
      ]);
    }),
  );

  it.effect("treats a duplicate link as alreadyLinked rather than an error", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([makeLink(123)]),
        reject: (command) =>
          command.type === "thread.pull-request.link" ? "already linked" : null,
      });
      const result = yield* harness.call("link_pull_request", {
        url: "https://github.com/sample-tools/goat/pull/123",
      });
      expect(result.alreadyLinked).toBe(true);
    }),
  );

  it.effect("unlinks a linked pull request and reports a missing one as wasLinked=false", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([makeLink(5)]),
        reject: (command) =>
          command.type === "thread.pull-request.unlink" && command.number !== 5
            ? "not linked"
            : null,
      });
      const linked = yield* harness.call("unlink_pull_request", {
        repository: "sample-tools/goat",
        number: 5,
      });
      expect(linked).toEqual({
        host: "github.com",
        repository: "sample-tools/goat",
        number: 5,
        wasLinked: true,
      });
      const missing = yield* harness.call("unlink_pull_request", {
        url: "https://github.com/sample-tools/goat/pull/9",
      });
      expect(missing.wasLinked).toBe(false);
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.unlink", number: 5 },
      ]);
    }),
  );

  it("reports an older Forgejo link's HTTP port when listing thread links", () => {
    const result = listThreadPullRequests(
      makeThread([
        makeLink(42, {
          host: "forge.example",
          url: "http://forge.example:3000/sample-tools/goat/pulls/42",
        }),
      ]),
    );
    expect(result.pullRequests[0]?.host).toBe("forge.example:3000");
  });

  it.effect("lists visible links with host state and derived chain order", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([
          makeLink(3, { headBranch: "feat-c", baseBranch: "feat-b", source: "agent" }),
          makeLink(1, { headBranch: "feat-a", baseBranch: "main", source: "created" }),
          makeLink(2, { headBranch: "feat-b", baseBranch: "feat-a", source: "agent" }),
          makeLink(9, { source: "stack-dismissed" }),
          makeLink(10),
        ]),
      });
      const result = yield* harness.call("list_thread_pull_requests", {});
      expect(result.pullRequests.map((entry) => entry.number)).toEqual([3, 1, 2, 10]);
      expect(result.pullRequests[0]).toEqual({
        host: "github.com",
        repository: "sample-tools/goat",
        number: 3,
        url: "https://github.com/sample-tools/goat/pull/3",
        source: "agent",
        watching: false,
        state: "open",
        title: "PR 3",
        headBranch: "feat-c",
        baseBranch: "feat-b",
        isDraft: false,
        stack: { kind: "derived", position: 3, size: 3 },
      });
      expect(result.pullRequests[3]).toMatchObject({
        number: 10,
        state: null,
        title: null,
        headBranch: null,
        stack: null,
      });
      expect(result.chains).toEqual([
        { kind: "derived", numbers: [1, 2, 3] },
        { kind: "derived", numbers: [10] },
      ]);
    }),
  );
});

describe("listThreadPullRequests", () => {
  it("reports a native stack position for each member", () => {
    const stack = {
      kind: "native" as const,
      id: "stack-1",
      number: 1,
      url: "https://github.com/sample-tools/goat/stack/1",
      base: "main",
      layers: [
        { number: 1, headBranch: "a", state: "open" as const },
        { number: 2, headBranch: "b", state: "open" as const },
      ],
    };
    const result = listThreadPullRequests({
      pullRequests: [
        makeLink(2, { stack, source: "stack" }),
        makeLink(1, { stack, source: "created" }),
      ],
    });
    expect(result.pullRequests.map((entry) => [entry.number, entry.stack])).toEqual([
      [2, { kind: "native", position: 2, size: 2 }],
      [1, { kind: "native", position: 1, size: 2 }],
    ]);
    expect(result.chains).toEqual([{ kind: "native", numbers: [1, 2] }]);
  });

  it("gives pull requests built on the same one the same position", () => {
    const result = listThreadPullRequests({
      pullRequests: [
        makeLink(1, { headBranch: "feat-a", baseBranch: "main" }),
        makeLink(2, { headBranch: "feat-b", baseBranch: "feat-a" }),
        makeLink(3, { headBranch: "feat-c", baseBranch: "feat-a" }),
      ],
    });
    expect(result.pullRequests.map((entry) => [entry.number, entry.stack])).toEqual([
      [1, { kind: "derived", position: 1, size: 3 }],
      [2, { kind: "derived", position: 2, size: 3 }],
      [3, { kind: "derived", position: 2, size: 3 }],
    ]);
    expect(result.chains).toEqual([{ kind: "derived", numbers: [1, 2, 3] }]);
  });
});

describe("pull request guide tools", () => {
  it.effect(
    "writes guides through the project whose checkout is each pull request's repository",
    () =>
      Effect.gen(function* () {
        const other = {
          ...makeProject({
            canonicalKey: "github.com/acme/web",
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "git@github.com:acme/web.git",
            },
            provider: SourceControlProviderKind.make("github"),
            displayName: "acme/web",
            owner: "acme",
            name: "web",
          }),
          id: ProjectId.make("project-web"),
        };
        const harness = yield* makeHarness({ projects: [makeProject(), other] });
        const result = yield* harness.call("write_pull_request_guides", {
          pullRequests: [
            { url: "https://github.com/acme/web/pull/7" },
            { repository: "sample-tools/goat", number: 12 },
            { url: "https://github.com/someone/else/pull/1" },
          ],
        });
        expect(
          result.guides.map((guide) => [guide.repository, guide.number, guide.outcome]),
        ).toEqual([
          ["acme/web", 7, "started"],
          ["sample-tools/goat", 12, "started"],
          ["someone/else", 1, "failed"],
        ]);
        expect(result.guides[2]?.detail).toContain("No project in this environment");
        expect(
          (yield* Ref.get(harness.guideRequests)).map((ref) => [ref.projectId, ref.number]),
        ).toEqual([
          ["project-web", 7],
          [PROJECT_ID, 12],
        ]);
      }),
  );

  it.effect("reports an unreadable entry on its own and still writes the rest of the batch", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("write_pull_request_guides", {
        pullRequests: [
          { url: "https://example.com/not-a-pull-request" },
          { repository: "sample-tools/goat" },
          { repository: "sample-tools/goat", number: 5 },
        ],
      });
      expect(result.guides.map((guide) => guide.outcome)).toEqual(["failed", "failed", "started"]);
      expect(result.guides[0]?.detail).toContain("not a recognised pull request URL");
      expect(result.guides[1]?.detail).toContain("Pass either url");
      expect((yield* Ref.get(harness.guideRequests)).map((ref) => ref.number)).toEqual([5]);
    }),
  );

  it.effect("finds an Azure DevOps checkout for a pull request named by its full path", () =>
    Effect.gen(function* () {
      const azure = {
        ...makeProject({
          canonicalKey: "dev.azure.com/org/project/_git/web",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "https://dev.azure.com/org/project/_git/web",
          },
          provider: SourceControlProviderKind.make("azure-devops"),
          displayName: "org/project/_git/web",
          owner: "org",
          name: "web",
        }),
        id: ProjectId.make("project-azure"),
      };
      const harness = yield* makeHarness({ projects: [makeProject(), azure] });
      const result = yield* harness.call("write_pull_request_guides", {
        pullRequests: [{ host: "dev.azure.com", repository: "org/project/_git/web", number: 9 }],
      });
      expect(result.guides.map((guide) => guide.outcome)).toEqual(["started"]);
      expect((yield* Ref.get(harness.guideRequests)).map((ref) => ref.projectId)).toEqual([
        "project-azure",
      ]);
    }),
  );
});

describe("pull request reads", () => {
  it.effect(
    "reads checks through the project holding the repository and passes on the host's refusal",
    () =>
      Effect.gen(function* () {
        const checks: PullRequestChecks = { state: "open", checks: [] };
        const harness = yield* makeHarness({
          checks: (input) =>
            input.number === 13
              ? Effect.fail(
                  new PullRequestOperationError({ operation: "checks", detail: "rate limited" }),
                )
              : Effect.succeed(checks),
        });
        expect(
          yield* harness.call("goat_pull_request_checks", {
            url: "https://github.com/sample-tools/goat/pull/12",
          }),
        ).toEqual({
          host: "github.com",
          repository: "sample-tools/goat",
          number: 12,
          url: "https://github.com/sample-tools/goat/pull/12",
          checks,
        });
        expect(
          yield* harness
            .call("goat_pull_request_checks", { repository: "sample-tools/goat", number: 13 })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "PullRequestReadFailedError", detail: "rate limited" });
        expect(
          yield* harness
            .call("goat_pull_request_checks", { url: "https://github.com/someone/else/pull/1" })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "PullRequestProjectNotFoundError" });
        expect((yield* Ref.get(harness.reads)).map((ref) => [ref.projectId, ref.number])).toEqual([
          [PROJECT_ID, 12],
          [PROJECT_ID, 13],
        ]);
      }),
  );
  it.effect(
    "reads detail fresh, returns input mistakes as the caller's, and finds the host from the one project holding the repository",
    () =>
      Effect.gen(function* () {
        // No calling project, as for a client outside any thread.
        const harness = yield* makeHarness({ thread: null });
        expect(
          yield* harness
            .call("goat_pull_request_read", { repository: "sample-tools/goat", number: 4 })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "PullRequestReadFailedError", detail: "offline" });
        expect(yield* Ref.get(harness.reads)).toMatchObject([
          { projectId: PROJECT_ID, host: "github.com", number: 4, allowStale: false },
        ]);
        expect(yield* harness.call("goat_pull_request_read", {}).pipe(Effect.flip)).toMatchObject({
          _tag: "PullRequestTargetIncompleteError",
        });
        expect(
          yield* harness.call("goat_pull_request_checks", { url: "not-a-url" }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "PullRequestUrlInvalidError" });
      }),
  );
  it.effect(
    "refuses a short repository name several repositories answer to, and reads a lone one at its full path",
    () =>
      Effect.gen(function* () {
        const azure = (
          org: string,
          name: string,
          id = ProjectId.make(`project-${org}-${name}`),
        ) => ({
          ...makeProject({
            canonicalKey: `dev.azure.com/${org}/project/_git/${name}`,
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: `https://dev.azure.com/${org}/project/_git/${name}`,
            },
            provider: SourceControlProviderKind.make("azure-devops"),
            displayName: `${org}/project/_git/${name}`,
            owner: org,
            name,
          }),
          id,
        });
        // The caller's own project, on the same host, holds neither.
        const caller = azure("one", "api", PROJECT_ID);
        const shared = yield* makeHarness({
          project: caller,
          projects: [caller, azure("one", "web"), azure("two", "web")],
        });
        expect(
          yield* shared
            .call("goat_pull_request_checks", { repository: "web", number: 9 })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "PullRequestRepositoryAmbiguousError" });
        expect(
          yield* shared
            .call("goat_pull_request_checks", {
              host: "dev.azure.com",
              repository: "web",
              number: 9,
            })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "PullRequestRepositoryAmbiguousError" });
        expect(yield* Ref.get(shared.reads)).toEqual([]);

        const lone = yield* makeHarness({ thread: null, projects: [azure("two", "web")] });
        const result = yield* lone.call("goat_pull_request_checks", {
          repository: "web",
          number: 9,
        });
        expect(result.url).toContain("/two/project/_git/web/");
        const named = yield* lone.call("goat_pull_request_checks", {
          host: "dev.azure.com",
          repository: "web",
          number: 9,
        });
        expect(named.url).toBe(result.url);
        // The organization's visualstudio.com host names the same repository.
        const aliased = yield* lone.call("goat_pull_request_checks", {
          host: "two.visualstudio.com",
          repository: "web",
          number: 9,
        });
        expect(aliased.url).toBe(result.url);
        // So does that host with the path past the organization, as its own URLs spell it.
        const aliasedPath = yield* lone.call("goat_pull_request_checks", {
          host: "two.visualstudio.com",
          repository: "project/_git/web",
          number: 9,
        });
        expect(aliasedPath.url).toBe(result.url);
        expect((yield* Ref.get(lone.reads)).map((ref) => [ref.projectId, ref.repository])).toEqual([
          ["project-two-web", result.repository],
          ["project-two-web", result.repository],
          ["project-two-web", result.repository],
          ["project-two-web", result.repository],
        ]);
      }),
  );
});

describe("pull request reads within the budget", () => {
  it.effect(
    "keeps a search, a file and a conversation within 256 KiB and says what it left out",
    () =>
      Effect.gen(function* () {
        const big = "x".repeat(200 * 1024);
        const comment = (id: string) => ({
          id,
          kind: "issue-comment" as const,
          author: null,
          body: big,
          createdAt: "2026-10-01T00:00:00.000Z",
          url: null,
          path: null,
          reviewState: null,
        });
        const entry = (number: number) => ({
          provider: SourceControlProviderKind.make("github"),
          host: "github.com",
          projectId: PROJECT_ID,
          projectTitle: "Project",
          repository: "sample-tools/goat",
          number,
          title: `PR ${number}`,
          url: `https://github.com/sample-tools/goat/pull/${number}`,
          author: null,
          headBranch: "feature",
          baseBranch: "main",
          state: "open" as const,
          isDraft: false,
          mergeability: "mergeable" as const,
          additions: 0,
          deletions: 0,
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
          viewerReviewRequested: false,
          labels: [],
        });
        const harness = yield* makeHarness({
          service: {
            activity: () =>
              Effect.succeed({
                comments: [comment("c1"), comment("c2")],
                commentCount: 2,
                commentsTruncated: false,
                reviewThreads: [],
                commits: [1, 2].map((n) => ({
                  oid: `commit-${n}`,
                  messageHeadline: big,
                  committedDate: "2026-10-01T00:00:00.000Z",
                })),
              }),
            diffFileContents: () =>
              Effect.succeed({ oldContents: "é".repeat(200 * 1024), newContents: "ok" }),
            list: (input) =>
              Effect.succeed({
                viewers: {},
                providers: [],
                entries:
                  input.query === "huge"
                    ? [
                        { ...entry(4), title: big },
                        { ...entry(5), title: big },
                      ]
                    : [entry(1), entry(2), entry(3)],
                errors: [],
                truncated: true,
                nextCursors: { "github.com/sample-tools/goat": "next" },
              }),
          },
        });
        const target = { url: "https://github.com/sample-tools/goat/pull/12" };
        const activity = yield* harness.call("goat_pull_request_activity", target);
        // Every list shares one budget: commits after the kept comment are counted as left out.
        expect(activity.activity.comments.map((kept) => kept.id)).toEqual(["c1"]);
        expect([activity.commentsOmitted, activity.commitsOmitted]).toEqual([1, 2]);
        expect(Buffer.byteLength(JSON.stringify(activity), "utf8")).toBeLessThanOrEqual(256 * 1024);
        const file = yield* harness.call("goat_pull_request_file", {
          ...target,
          changeType: "change",
          oldPath: "a.ts",
          newPath: "a.ts",
        });
        expect(Buffer.byteLength(file.oldContents, "utf8")).toBeLessThanOrEqual(256 * 1024);
        expect(file.oldContents.endsWith("é")).toBe(true);
        expect([file.oldTruncated, file.newTruncated]).toEqual([true, false]);
        // Rows are never cut, so the service's cursors continue without a gap.
        const page = yield* harness.call("goat_pull_request_search", { state: "open", limit: 2 });
        expect(page.entries).toHaveLength(3);
        expect(page).toMatchObject({
          truncated: true,
          nextCursors: { "github.com/sample-tools/goat": "next" },
        });
        const huge = yield* harness
          .call("goat_pull_request_search", { state: "open", query: "huge" })
          .pipe(Effect.flip);
        expect(huge._tag).toBe("PullRequestSearchTooLargeError");
      }),
  );
});
