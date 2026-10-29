import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { afterEach, expect, it, vi } from "@effect/vitest";
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
import * as GitHubPullRequestProvider from "./GitHubPullRequestProvider.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
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

const mockedExecute = vi.fn<(call: ApiCall) => ApiAnswer>();
const defaultCredential = (host: string) =>
  Effect.succeed({ token: Redacted.make("token"), fingerprint: `${host}:token` });
const mockedCredential = vi.fn(defaultCredential);
const mockedStackMemberships = vi.fn<(call: ApiCall) => ApiAnswer>(() =>
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

const layer = it.layer(
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

function output(
  body: string,
  truncated = false,
  invalidUtf8 = false,
  headers: Readonly<Record<string, string>> = {},
  status = 200,
): GitHubRest.GitHubRestResponse {
  return { status, headers, body, truncated, invalidUtf8 };
}

function matches(call: ApiCall, needle: string): boolean {
  return call.kind === "graphql"
    ? call.operationName === needle || call.query.includes(needle)
    : call.path.includes(needle);
}

function route(...routes: ReadonlyArray<readonly [needle: string, body: unknown]>): void {
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

function variablesOf(needle: string): ReadonlyArray<Readonly<Record<string, unknown>>> {
  return mockedExecute.mock.calls.flatMap(([call]) =>
    call.kind === "graphql" && matches(call, needle) ? [call.variables ?? {}] : [],
  );
}

afterEach(() => {
  mockedExecute.mockReset();
  mockedStackMemberships.mockReset();
  mockedCredential.mockReset();
  mockedCredential.mockImplementation(defaultCredential);
});

layer("GitHub pinned merge", (it) => {
  const actionState = (pullRequest: Readonly<Record<string, unknown>> = {}) => ({
    data: {
      repository: {
        pullRequest: {
          id: "PR_7",
          headRefOid: "abc123",
          isMergeQueueEnabled: false,
          mergeStateStatus: "BLOCKED",
          baseRef: { compare: { behindBy: 2 } },
          ...pullRequest,
        },
      },
    },
  });
  const mergeMessage = (body: string, isMergeQueueEnabled = false) => ({
    data: {
      repository: {
        pullRequest: { isMergeQueueEnabled, headRefOid: "abc123", viewerMergeBodyText: body },
      },
    },
  });

  it.effect(
    "refuses a pinned merge queue before any mutation while an unpinned merge enters the queue",
    () =>
      Effect.gen(function* () {
        route(["query PullRequestActionState", actionState({ isMergeQueueEnabled: true })]);
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        const ref = {
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          action: "merge" as const,
        };
        const error = yield* Effect.flip(
          cli.runPullRequestAction({ ...ref, headSha: "reviewed-head" }),
        );
        expect(error.message).toMatch(/queued|automatic/i);
        expect(variablesOf("mergePullRequest(")).toEqual([]);
        expect(variablesOf("enablePullRequestAutoMerge(")).toEqual([]);
        const provider = yield* GitHubPullRequestProvider.make;
        const providerError = yield* Effect.flip(
          provider.runAction({ ...ref, headSha: "reviewed-head" }),
        );
        expect(providerError).toMatchObject({ reason: "pinned-auto-merge" });
        yield* cli.runPullRequestAction(ref);
        expect(variablesOf("enablePullRequestAutoMerge(")).toHaveLength(1);
      }),
  );

  it.effect.each(["BLOCKED", "CLEAN"])(
    "refuses a pinned automatic merge even when state is %s",
    (mergeStateStatus) =>
      Effect.gen(function* () {
        route(["query PullRequestActionState", actionState({ mergeStateStatus })]);
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        const result = yield* Effect.result(
          cli.runPullRequestAction({
            cwd: "/w",
            repository: "acme/web",
            host: "github.com",
            number: 7,
            action: "enable-auto-merge",
            headSha: "reviewed-head",
          }),
        );
        expect(result).toMatchObject({ _tag: "Failure" });
        expect(variablesOf("mergePullRequest(")).toEqual([]);
        expect(variablesOf("enablePullRequestAutoMerge(")).toEqual([]);
      }),
  );

  it.effect.each(["merge"] as const)(
    "pins the reviewed head in the GitHub mutation for %s",
    (action) =>
      Effect.gen(function* () {
        route(["query PullRequestActionState", actionState()]);
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        yield* cli.runPullRequestAction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          action,
          headSha: "reviewed-head",
        });
        expect(
          variablesOf(action === "merge" ? "mergePullRequest(" : "enablePullRequestAutoMerge("),
        ).toEqual([
          {
            input: {
              pullRequestId: "PR_7",
              mergeMethod: "MERGE",
              expectedHeadOid: "reviewed-head",
            },
          },
        ]);
      }),
  );

  it.effect("refuses a merge when the reviewed head differs from the message head", () =>
    Effect.gen(function* () {
      route(
        [
          "query PullRequestMergeMessage",
          mergeMessage("Co-authored-by: Claude <noreply@anthropic.com>"),
        ],
        ["query PullRequestActionState", actionState()],
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const result = yield* Effect.result(
        cli.runPullRequestAction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          action: "merge",
          headSha: "reviewed-head",
          removeAgentCreditsOnMerge: true,
        }),
      );
      expect(result._tag).toBe("Failure");
      expect(variablesOf("mergePullRequest(")).toEqual([]);
      const provider = yield* GitHubPullRequestProvider.make;
      const error = yield* Effect.flip(
        provider.runAction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          action: "merge",
          headSha: "reviewed-head",
          removeAgentCreditsOnMerge: true,
        }),
      );
      expect(error).toMatchObject({
        reason: "pinned-head-refused",
        detail: expect.stringMatching(/merge message head/i),
      });
      expect(variablesOf("mergePullRequest(")).toEqual([]);
    }),
  );

  it.effect("classifies a pinned stack refusal before a host write", () =>
    Effect.gen(function* () {
      const provider = yield* GitHubPullRequestProvider.make;
      const error = yield* Effect.flip(
        provider.runAction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          action: "merge",
          headSha: "reviewed-head",
          stackNumber: 1,
        }),
      );
      expect(error).toMatchObject({ reason: "pinned-head-refused" });
      expect(variablesOf("mergePullRequest(")).toEqual([]);
    }),
  );

  it.effect("surfaces GitHub's refusal when the reviewed head moved", () =>
    Effect.gen(function* () {
      route(["query PullRequestActionState", actionState()]);
      const answer = mockedExecute.getMockImplementation()!;
      mockedExecute.mockImplementation((call) =>
        call.kind === "graphql" && call.query.includes("mergePullRequest(")
          ? Effect.fail(
              new GitHubRequestPolicy.GitHubApiResponseError({
                host: call.host,
                operation: call.operation,
                status: 409,
              }),
            )
          : answer(call),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const result = yield* Effect.result(
        cli.runPullRequestAction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          action: "merge",
          headSha: "reviewed-head",
        }),
      );
      expect(result._tag).toBe("Failure");
      expect(variablesOf("mergePullRequest(")[0]).toMatchObject({
        input: { expectedHeadOid: "reviewed-head" },
      });
      const provider = yield* GitHubPullRequestProvider.make;
      const error = yield* Effect.flip(
        provider.runAction({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          action: "merge",
          headSha: "reviewed-head",
        }),
      );
      expect(error).toMatchObject({ reason: "failed" });
    }),
  );
});
