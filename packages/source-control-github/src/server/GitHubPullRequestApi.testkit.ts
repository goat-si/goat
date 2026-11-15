// @effect-diagnostics preferSchemaOverJson:off - Moved test fixtures parse recorded request bodies.
import { rowDefaults, coreResponse, lastPage, rows } from "./gitHubPullRequestTestFixtures.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as SourceControlRateLimit from "@goat/source-control-core/server/SourceControlRateLimit";
import * as TestSourceControlHost from "@goat/source-control-testing/TestSourceControlHost";
import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";

export const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

// GitHub's field-level reviewer refusal; the surrounding response data is synthetic.
export const refusedReviewer = {
  type: "FORBIDDEN",
  message: "Resource not accessible by integration",
  path: ["repository", "pullRequest", "reviewRequests", "nodes", 0, "requestedReviewer"],
};
export const pullRequestInput = {
  cwd: "/w",
  repository: "acme/web",
  host: "github.com",
  number: 7,
};
export type PullRequestRead = (
  input: typeof pullRequestInput,
) => Effect.Effect<unknown, GitHubPullRequestApi.GitHubPullRequestApiError>;
export const refusedReviewerResponse = () =>
  Effect.succeed(output(encodeJson({ ...coreResponse(), errors: [refusedReviewer] })));

type ApiCall =
  | {
      readonly kind: "graphql";
      readonly authorization: string | undefined;
      readonly partial?: boolean;
      readonly operationName?: string;
      readonly host: string;
      readonly operation: string;
      readonly query: string;
      readonly variables?: Readonly<Record<string, unknown>>;
    }
  | ({ readonly kind: "rest" } & GitHubRest.GitHubRestInput);

type ApiAnswer = Effect.Effect<GitHubRest.GitHubRestResponse, GitHubRequestPolicy.GitHubApiError>;

export const mockedExecute = vi.fn<(call: ApiCall) => ApiAnswer>();
export const defaultCredential = (host: string) =>
  Effect.succeed({ token: Redacted.make("token"), fingerprint: `${host}:token` });
export const mockedCredential = vi.fn(defaultCredential);
export const mockedStackMemberships = vi.fn<(call: ApiCall) => ApiAnswer>(() =>
  Effect.succeed(output('{"data":{}}')),
);

const mockApi = Layer.succeed(
  GitHubRest.GitHubRest,
  GitHubRest.GitHubRest.of({
    rest: (input) => mockedExecute({ kind: "rest", ...input }),
    credential: (host) => mockedCredential(host),
  }),
);

const mockHttp = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.gen(function* () {
      const host = new URL(request.url).hostname.replace(/^api\./, "");
      const sent =
        request.body._tag === "Uint8Array"
          ? (JSON.parse(new TextDecoder().decode(request.body.body)) as {
              readonly query: string;
              readonly operationName: string;
              readonly variables: Readonly<Record<string, unknown>>;
            })
          : { query: "", operationName: "", variables: {} };
      const call: ApiCall = {
        kind: "graphql",
        authorization: request.headers["authorization"],
        host,
        operation: "batch",
        operationName: sent.operationName,
        query: sent.query,
        variables: sent.variables,
        partial: true,
      };
      const answer = yield* (
        sent.query.startsWith("query PullRequestStackMembership(")
          ? mockedStackMemberships
          : mockedExecute
      )(call).pipe(
        Effect.catchTags({
          GitHubApiResponseError: (error) =>
            Effect.succeed(output('{"message":"Bad gateway"}', false, false, {}, error.status)),
        }),
        Effect.orDie,
      );
      // Empty mutation mocks still need the selected GraphQL root field.
      const body =
        answer.body === "{}" && sent.query.startsWith("mutation ")
          ? encodeJson(mutationAnswer(sent.query))
          : answer.body;
      return HttpClientResponse.fromWeb(
        request,
        new Response(body, {
          status: answer.status,
          headers: { "content-type": "application/json", ...answer.headers },
        }),
      );
    }),
  ),
);

export const layer = it.layer(
  GitHubPullRequestApi.layer.pipe(
    Layer.provideMerge(mockApi),
    Layer.provideMerge(GitHubRequestPolicy.layer),
    Layer.provideMerge(GitHubQuota.layer),
    Layer.provideMerge(SourceControlRateLimit.layer),
    Layer.provideMerge(mockHttp),
    Layer.provideMerge(
      Layer.succeed(GitHubCredentials.GitHubCredentials, {
        get: (host) =>
          Effect.map(mockedCredential(host), (held) => ({ ...held, host, source: "gh" as const })),
        invalidate: () => Effect.void,
      }),
    ),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(TestSourceControlHost.layer()),
    Layer.provide(NodeServices.layer),
  ),
);

export function output(
  body: string,
  truncated = false,
  invalidUtf8 = false,
  headers: Readonly<Record<string, string>> = {},
  status = 200,
): GitHubRest.GitHubRestResponse {
  return { status, headers, body, truncated, invalidUtf8 };
}

export function graphqlQuota(remaining: number, resetAt = "2099-08-13T14:00:00Z") {
  return {
    "x-ratelimit-resource": "graphql",
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": String(remaining),
    "x-ratelimit-reset": String(Date.parse(resetAt) / 1000),
  };
}

export function pullRequests(
  count: number,
  firstNumber: number,
  overrides?: (number: number) => Readonly<Record<string, unknown>>,
): string {
  return encodeJson({
    data: {
      search: { pageInfo: lastPage, nodes: rows(count, firstNumber, overrides) },
    },
  });
}

export function listedPullRequests(
  count: number,
  firstNumber: number,
  overrides?: (number: number) => Readonly<Record<string, unknown>>,
): string {
  return encodeJson({
    data: {
      repository: {
        pullRequests: {
          pageInfo: lastPage,
          nodes: rows(count, firstNumber, overrides),
        },
      },
    },
  });
}

export const emptySearch = () => output(pullRequests(0, 1));
export const emptyList = () => output(listedPullRequests(0, 1));

export function pullRequestFiles(count: number, firstIndex: number): string {
  return encodeJson(
    Array.from({ length: count }, (_, index) => ({
      filename: `src/file${firstIndex + index}.ts`,
      status: "modified",
      patch: "@@ -1 +1 @@\n-old\n+new",
    })),
  );
}

export function threadComments(
  ids: ReadonlyArray<string>,
  endCursor: string | null,
  totalCount = ids.length,
  author: Readonly<Record<string, unknown>> | null = null,
) {
  return {
    totalCount,
    pageInfo: { hasNextPage: endCursor !== null, endCursor },
    nodes: ids.map((id) => ({
      id,
      author,
      body: id,
      createdAt: "2026-07-01T00:00:00Z",
      lastEditedAt: null,
      url: `https://github.com/acme/web/pull/7#discussion_${id}`,
      isMinimized: false,
      reactionGroups: [],
    })),
  };
}

export function thread(id: string, ...commentIds: ReadonlyArray<string>) {
  return {
    id,
    path: "src/a.ts",
    line: 1,
    diffSide: "RIGHT",
    isResolved: false,
    isOutdated: false,
    comments: threadComments(commentIds, null),
  };
}

export function reviewThreadsPage(
  nodes: ReadonlyArray<Record<string, unknown>>,
  endCursor: string | null,
  requestedReviewers: ReadonlyArray<Record<string, unknown>> = [],
): string {
  return encodeJson({
    data: {
      viewer: { login: "viewer" },
      repository: {
        pullRequest: {
          reviewThreads: {
            totalCount: nodes.length,
            pageInfo: { hasNextPage: endCursor !== null, endCursor },
            nodes,
          },
          viewerCanUpdate: true,
          viewerDidAuthor: false,
          author: null,
          reactionGroups: [],
          comments: { nodes: [] },
          reviews: { nodes: [] },
          reviewRequests: {
            nodes: requestedReviewers.map((requestedReviewer) => ({ requestedReviewer })),
          },
          latestReviews: { nodes: [] },
          reviewDismissals: { pageInfo: lastPage, nodes: [] },
          commits: { nodes: [] },
        },
      },
    },
  });
}

export function threadCommentsPage(
  ids: ReadonlyArray<string>,
  endCursor: string | null,
  totalCount: number,
  pullRequestId = "PR_7",
): string {
  return encodeJson({
    data: {
      viewer: { login: "viewer" },
      repository: { pullRequest: { id: "PR_7" } },
      node: {
        __typename: "PullRequestReviewThread",
        pullRequest: { id: pullRequestId },
        comments: threadComments(ids, endCursor, totalCount),
      },
    },
  });
}

export const diffRefused = new GitHubRequestPolicy.GitHubApiResponseError({
  host: "github.com",
  operation: "getPullRequestDiff",
  status: 406,
});

export function callAt(index: number): ApiCall {
  const call = mockedExecute.mock.calls[index];
  assert.isDefined(call);
  return call[0];
}

export function varsAt(index: number): Readonly<Record<string, unknown>> {
  const call = callAt(index);
  assert.strictEqual(call.kind, "graphql");
  return call.kind === "graphql" ? (call.variables ?? {}) : {};
}

export function queryAt(index: number): string {
  const call = callAt(index);
  return call.kind === "graphql" ? call.query : "";
}

export function pathAt(index: number): string {
  const call = callAt(index);
  return call.kind === "rest" ? call.path : "";
}

export function searchOfCall(index: number): string | undefined {
  const q = callAt(index).kind === "graphql" ? varsAt(index)["q"] : undefined;
  return typeof q === "string" ? q : undefined;
}

export function searchItem(number: number, repository: string, updatedAt: string) {
  return {
    ...rowDefaults,
    number,
    title: `Pull request ${number}`,
    url: `https://github.com/${repository}/pull/${number}`,
    author: {
      __typename: "User",
      login: "octocat",
      avatarUrl: "https://avatars/octocat",
      name: null,
    },
    headRefName: "feat/page",
    baseRefName: "main",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt,
    repository: { nameWithOwner: repository },
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: "hubot" } }] },
    labels: { nodes: [{ name: "bug", color: "ff0000", description: "Something is broken" }] },
  };
}

export function searchPage(nodes: ReadonlyArray<unknown>, hasNextPage = false) {
  return output(
    encodeJson({
      data: {
        search: { pageInfo: { hasNextPage, endCursor: hasNextPage ? "next" : null }, nodes },
      },
    }),
  );
}

export function matches(call: ApiCall, needle: string): boolean {
  return call.kind === "graphql"
    ? call.operationName === needle || call.query.includes(needle)
    : call.path.includes(needle);
}

export function route(...routes: ReadonlyArray<readonly [needle: string, body: unknown]>): void {
  mockedExecute.mockImplementation((call) => {
    const match = routes.find(([needle]) => matches(call, needle));
    return Effect.succeed(
      output(
        match !== undefined
          ? encodeJson(match[1])
          : call.kind === "graphql" && call.query.startsWith("mutation ")
            ? encodeJson(mutationAnswer(call.query))
            : "{}",
      ),
    );
  });
}

function mutationAnswer(query: string) {
  const root = /\)\{(\w+)(?:\(|\{|@)/.exec(query)?.[1];
  return { data: root === undefined ? {} : { [root]: null } };
}

export function variablesOf(needle: string): ReadonlyArray<Readonly<Record<string, unknown>>> {
  return mockedExecute.mock.calls.flatMap(([call]) =>
    call.kind === "graphql" && matches(call, needle) ? [call.variables ?? {}] : [],
  );
}

export function restCallsTo(needle: string): ReadonlyArray<GitHubRest.GitHubRestInput> {
  return mockedExecute.mock.calls.flatMap(([call]) =>
    call.kind === "rest" && call.path.includes(needle) ? [call] : [],
  );
}

/** Route before the node-ID lookup, whose document is contained in this scope query. */
export const SUBJECT_SCOPE_QUERY = "PullRequestSubject";
export const subjectScope = (subjectId: string, pullRequestId: string) => ({
  data: {
    repository: { pullRequest: { id: pullRequestId } },
    node: { __typename: "IssueComment", id: subjectId, pullRequest: { id: pullRequestId } },
  },
});

export const checkRun = (fields: Record<string, unknown>) => ({
  __typename: "CheckRun",
  name: "",
  status: "COMPLETED",
  conclusion: null,
  startedAt: null,
  completedAt: null,
  detailsUrl: null,
  checkSuite: { workflowRun: null },
  ...fields,
});

export const checkContextsPage = (
  nodes: ReadonlyArray<Record<string, unknown>>,
  endCursor: string | null,
  headRefOid = "abc123",
) =>
  encodeJson({
    data: {
      repository: {
        pullRequest: {
          headRefOid,
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } },
                  },
                },
              },
            ],
          },
        },
      },
    },
  });

export const pullRequestRefs = encodeJson({ base: { sha: "a1b2c3d" }, head: { sha: "b1c2d3e" } });
export const pullRequestMergeBase = encodeJson({ merge_base_commit: { sha: "c1d2e3f" } });

export const crossRepositoryDetail = (headRefOid = "abc123") =>
  coreResponse({
    headRefName: "feat/page",
    headRefOid,
    isCrossRepository: true,
    headRepositoryOwner: { __typename: "User", login: "octocat" },
  });

export const heads = (numbers: ReadonlyArray<number>) => ({
  data: {
    repository: {
      pullRequests: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: numbers.map((number) => ({
          number,
          headRefOid: "abc123",
          isCrossRepository: true,
          headRepositoryOwner: { __typename: "User", login: "octocat" },
        })),
      },
    },
  },
});

export const workflowRuns = (ids: ReadonlyArray<number>) => ({
  workflow_runs: ids.map((id) => ({
    id,
    name: id === 10 ? "build" : `run ${id}`,
    html_url: `https://example.com/${id}`,
  })),
});

export function workflowApprovalRoutes(
  detail: () => unknown,
  headsAnswer: unknown,
  runsAnswer: unknown,
): void {
  mockedExecute.mockImplementation((call) =>
    Effect.sync(() =>
      output(
        call.kind === "rest"
          ? call.path.endsWith("/approve")
            ? ""
            : encodeJson(runsAnswer)
          : call.operationName === "PullRequestHeads"
            ? encodeJson(headsAnswer)
            : encodeJson(detail()),
      ),
    ),
  );
}

/** Node IDs stay cached after the first test. */
export const NODE_ID_QUERY = "PullRequestNodeId";
export const nodeIdAnswer = (id: string) => ({ data: { repository: { pullRequest: { id } } } });
