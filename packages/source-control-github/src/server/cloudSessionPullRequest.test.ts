import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as SourceControlRateLimit from "@goat/source-control-core/server/SourceControlRateLimit";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
import * as GitHubPullRequestProvider from "./GitHubPullRequestProvider.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubRest from "./GitHubRest.ts";
import { containsSessionUrl, make, summarySection } from "./cloudSessionPullRequest.ts";

const SESSION_URL = "https://claude.ai/code/session_ABC123";
const input = {
  cwd: "/fixture/project",
  host: "github.com",
  repository: "fixture/repository",
  sessionUrl: SESSION_URL,
};
const SHA = "a".repeat(40);
const pr = (number = 7, body: string | null = null, repo = input.repository) => ({
  number,
  html_url: `https://github.com/${repo}/pull/${number}`,
  body,
  base: { repo: { full_name: repo } },
  head: { ref: "claude/result", sha: SHA },
});
const commitResponse = (message = "Unrelated", cursor: string | null = null, sha = SHA) =>
  JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          headRefOid: sha,
          commits: {
            nodes: [{ commit: { message } }],
            pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
          },
        },
      },
    },
  });
const restResponse = (
  reply: Partial<GitHubRest.GitHubRestResponse> = {},
): GitHubRest.GitHubRestResponse => ({
  status: 200,
  headers: {},
  body: "[]",
  truncated: false,
  invalidUtf8: false,
  ...reply,
});
type GraphQlRequest = {
  readonly query: string;
  readonly variables: Readonly<Record<string, unknown>>;
};
/** GitHub's GraphQL endpoint, answering each request with a raw response body. */
const graphQlHttp = (answer: (request: GraphQlRequest) => Effect.Effect<string>) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      const sent: GraphQlRequest =
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : { query: "", variables: {} };
      return HttpClientResponse.fromWeb(
        request,
        new Response(yield* answer(sent), { headers: { "content-type": "application/json" } }),
      );
    }),
  );
const transport = (
  rest: GitHubRest.GitHubRest["Service"]["rest"],
  graphql: (request: GraphQlRequest) => Effect.Effect<string> = () =>
    Effect.succeed(commitResponse()),
) =>
  Layer.mergeAll(
    Layer.mock(GitHubRest.GitHubRest)({ rest }),
    GitHubRequestPolicy.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(GitHubCredentials.GitHubCredentials, {
            get: (host) =>
              Effect.succeed({
                host,
                token: Redacted.make("fixture-token"),
                source: "gh" as const,
                fingerprint: "fixture-account",
              }),
            invalidate: () => Effect.void,
          }),
          GitHubQuota.layer,
          SourceControlRateLimit.layer,
        ),
      ),
    ),
    Layer.succeed(HttpClient.HttpClient, graphQlHttp(graphql)),
  );
const makeLookup = (
  rest: GitHubRest.GitHubRest["Service"]["rest"],
  graphql?: (request: GraphQlRequest) => Effect.Effect<string>,
) => make.pipe(Effect.provide(transport(rest, graphql)));
const pinned = (fingerprint = "fixture-account", host = input.host) => ({
  host,
  token: Redacted.make("fixture-token"),
  credentialFingerprint: fingerprint,
});
const observe = (
  find: Effect.Success<typeof make>,
  fingerprint = "fixture-account",
  source = input,
) =>
  find(source).pipe(
    Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, pinned(fingerprint)),
  );
const nextLink = { link: '<https://api.github.com/next>; rel="next"' };
const firstPage = Array.from({ length: 100 }, (_, index) => pr(index + 1));

it("correlates only the whole canonical URL token and bounds Summary", () => {
  for (const other of [
    `${SESSION_URL}OTHER`,
    `${SESSION_URL}/extra`,
    `${SESSION_URL}?q=1`,
    `${SESSION_URL}#x`,
    "https://claude.ai.evil/code/session_ABC123",
    "https://user@claude.ai/code/session_ABC123",
  ])
    expect(containsSessionUrl(other, SESSION_URL)).toBe(false);
  expect(containsSessionUrl(`Claude-Session: ${SESSION_URL}`, SESSION_URL)).toBe(true);
  expect(containsSessionUrl(`[session](${SESSION_URL}).`, SESSION_URL)).toBe(true);
  expect(summarySection("## Summary\r\nChanged function.\r\n## Verification\r\nChecks")).toBe(
    "Changed function.",
  );
  expect(summarySection("## Summary\n" + "x".repeat(5_000))).toHaveLength(4_000);
  expect(summarySection(null)).toBe("Result PR found. The PR has no Summary section.");
});

it.effect.each(["draft", "closed", "merged"])(
  "finds a %s PR body without any commit reads",
  (state) =>
    Effect.gen(function* () {
      let reads = 0;
      const find = yield* makeLookup(
        () =>
          Effect.sync(() => {
            reads++;
            return restResponse({
              body: JSON.stringify([
                {
                  ...pr(7, `## Summary\nDone\n## Checks\n${SESSION_URL}`),
                  draft: state === "draft",
                  state: state === "draft" ? "open" : "closed",
                  merged_at: state === "merged" ? "2026-01-01" : null,
                },
              ]),
            });
          }),
        () => Effect.die("A body result must not read commits"),
      );
      expect(yield* observe(find)).toEqual({
        prUrl: "https://github.com/fixture/repository/pull/7",
        branch: "claude/result",
        summary: "Done",
      });
      expect(reads).toBe(1);
    }),
);

it.effect("reads page-two bodies before all first-page commit fallbacks", () =>
  Effect.gen(function* () {
    const paths: string[] = [];
    const find = yield* makeLookup(
      (request) =>
        Effect.sync(() => {
          paths.push(request.path);
          return request.path.endsWith("page=1")
            ? restResponse({ body: JSON.stringify(firstPage), headers: nextLink })
            : restResponse({ body: JSON.stringify([pr(101, SESSION_URL)]) });
        }),
      () => Effect.die("Body discovery must precede commit fallback"),
    );
    expect((yield* observe(find))?.prUrl).toBe("https://github.com/fixture/repository/pull/101");
    expect(paths).toHaveLength(2);
    expect(paths[0]).toContain("state=all");
    expect(paths[1]).toContain("page=2");
  }),
);

it.effect("reads full commit messages and continues the commit connection", () =>
  Effect.gen(function* () {
    const cursors: unknown[] = [];
    const find = yield* makeLookup(
      () => Effect.succeed(restResponse({ body: JSON.stringify([pr()]) })),
      (request) =>
        Effect.sync(() => {
          expect(request.query).toContain("commit{message}");
          const after = request.variables.after;
          cursors.push(after);
          return after === null
            ? commitResponse("Headline", "page-two")
            : commitResponse(`Headline\n\nClaude-Session: ${SESSION_URL}`);
        }),
    );
    expect((yield* observe(find))?.branch).toBe("claude/result");
    expect(cursors).toEqual([null, "page-two"]);
  }),
);

it.effect(
  "retains the budget cursor until the next scheduled minute reaches page-two trailers",
  () =>
    Effect.gen(function* () {
      const reads: Array<{ number: number; after: unknown }> = [];
      const find = yield* makeLookup(
        (request) =>
          Effect.succeed(
            request.path.endsWith("page=1")
              ? restResponse({ body: JSON.stringify(firstPage), headers: nextLink })
              : restResponse({ body: JSON.stringify([pr(101, "## Summary\nTrailer result")]) }),
          ),
        (request) =>
          Effect.sync(() => {
            const number = Number(request.variables.number);
            const after = request.variables.after;
            reads.push({ number, after });
            if (number === 98 && after === null) return commitResponse("Unrelated", "more-98");
            return commitResponse(
              number === 101 ? `Headline\n\nClaude-Session: ${SESSION_URL}` : "Unrelated",
            );
          }),
      );
      const started = yield* Clock.currentTimeMillis;
      expect((yield* observe(find).pipe(Effect.flip))._tag).toBe("PullRequestProviderError");
      expect(reads.at(-1)).toEqual({ number: 98, after: null });
      yield* TestClock.adjust("1 minute");
      const result = yield* observe(find);
      expect(reads[98]).toEqual({ number: 98, after: "more-98" });
      expect(reads.filter((read) => read.number === 1)).toHaveLength(1);
      expect(result?.prUrl).toBe("https://github.com/fixture/repository/pull/101");
      expect(result?.summary).toBe("Trailer result");
      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(2 * 60 * 60_000);
    }),
);

it.effect(
  "resets changed heads individually and partitions progress by credentials and source",
  () =>
    Effect.gen(function* () {
      let changed = false;
      const reads: Array<{ number: number; after: unknown }> = [];
      const find = yield* makeLookup(
        (request) =>
          Effect.succeed(
            request.path.endsWith("page=1")
              ? restResponse({
                  body: JSON.stringify(
                    firstPage.map((row) =>
                      changed && row.number === 98
                        ? { ...row, head: { ...row.head, sha: "b".repeat(40) } }
                        : row,
                    ),
                  ),
                  headers: nextLink,
                })
              : restResponse({ body: JSON.stringify([pr(101)]) }),
          ),
        (request) =>
          Effect.sync(() => {
            const number = Number(request.variables.number);
            const after = request.variables.after;
            reads.push({ number, after });
            return commitResponse(
              "Unrelated",
              number === 98 && !changed ? "more-98" : null,
              changed && number === 98 ? "b".repeat(40) : SHA,
            );
          }),
      );
      yield* observe(find, "account-a").pipe(Effect.flip);
      changed = true;
      expect(yield* observe(find, "account-a")).toBeNull();
      expect(reads[98]).toEqual({ number: 98, after: null });
      for (const [fingerprint, source] of [
        ["account-b", input],
        ["account-a", { ...input, cwd: "/fixture/other" }],
        ["account-a", { ...input, sessionUrl: "https://claude.ai/code/session_OTHER" }],
      ] as const) {
        const before = reads.length;
        yield* observe(find, fingerprint, source).pipe(Effect.result);
        expect(reads[before]).toEqual({ number: 1, after: null });
      }
    }),
);

it.effect("never correlates a different repository or session", () =>
  Effect.gen(function* () {
    const find = yield* makeLookup(() =>
      Effect.succeed(
        restResponse({
          body: JSON.stringify([
            pr(7, SESSION_URL, "fixture/other"),
            pr(8, "https://claude.ai/code/session_OTHER"),
          ]),
        }),
      ),
    );
    expect(yield* observe(find)).toBeNull();
  }),
);

it.effect.each([
  { truncated: true },
  { invalidUtf8: true },
  { status: 503 },
  { body: "broken JSON" },
])("fails an incomplete REST page: %j", (reply) =>
  Effect.gen(function* () {
    const find = yield* makeLookup(() => Effect.succeed(restResponse(reply)));
    const error = yield* observe(find).pipe(Effect.flip);
    expect(error._tag).toBe("PullRequestProviderError");
    expect(error.cause).toBeDefined();
    expect(error.detail).not.toContain("broken JSON");
  }),
);

it.effect(
  "preserves immediate API causes with curated authentication, quota and transport errors",
  () =>
    Effect.gen(function* () {
      const cases = [
        [
          new GitHubRequestPolicy.GitHubApiAuthenticationError({
            host: input.host,
            operation: "read",
          }),
          "unauthenticated",
        ],
        [
          new GitHubRequestPolicy.GitHubApiRateLimitError({
            host: input.host,
            operation: "read",
            retryAt: 123,
          }),
          "rate-limited",
        ],
        [
          new GitHubRequestPolicy.GitHubApiRequestError({
            host: input.host,
            operation: "read",
            cause: "private-payload",
          }),
          "failed",
        ],
        [
          new GitHubRequestPolicy.GitHubApiNotFoundError({ host: input.host, operation: "read" }),
          "failed",
        ],
        [
          new GitHubRequestPolicy.GitHubApiResponseError({
            host: input.host,
            operation: "read",
            status: 500,
            githubErrors: ["private-payload"],
          }),
          "failed",
        ],
      ] as const;
      for (const [cause, reason] of cases) {
        const find = yield* makeLookup(() => Effect.fail(cause));
        const error = yield* observe(find).pipe(Effect.flip);
        expect(error.reason).toBe(reason);
        expect(error.cause).toBe(cause);
        expect(error.detail).not.toContain("private-payload");
        if (reason === "rate-limited") expect(error.retryAt).toBe(123);
      }
    }),
);

it.effect(
  "refuses invalid input and missing or mismatched pinned credentials before API calls",
  () =>
    Effect.gen(function* () {
      const find = yield* makeLookup(() => Effect.die("Must validate before reading"));
      expect((yield* find(input).pipe(Effect.flip))._tag).toBe("PullRequestProviderError");
      yield* find(input).pipe(
        Effect.provideService(
          GitHubRequestPolicy.PinnedGitHubCredential,
          pinned("account", "other.host"),
        ),
        Effect.flip,
      );
      for (const source of [
        { ...input, repository: "fixture/repository/extra" },
        { ...input, sessionUrl: `${SESSION_URL}?token=private` },
      ])
        yield* observe(find, "fixture-account", source).pipe(Effect.flip);
    }),
);

it.effect("fails listing-window overflow instead of reporting absence", () =>
  Effect.gen(function* () {
    let reads = 0;
    const find = yield* makeLookup(() =>
      Effect.sync(() => {
        reads++;
        return restResponse({ headers: nextLink });
      }),
    );
    expect((yield* observe(find).pipe(Effect.flip)).detail).toContain("pagination");
    expect(reads).toBe(20);
  }),
);

it.effect("blocked commit pagination stays incomplete while other candidates can still match", () =>
  Effect.gen(function* () {
    let matched = false;
    let reads = 0;
    const find = yield* makeLookup(
      () => Effect.succeed(restResponse({ body: JSON.stringify([pr(7), pr(8)]) })),
      (request) =>
        Effect.sync(() => {
          reads++;
          return request.variables.number === 7
            ? commitResponse("Unrelated", `cursor-${reads}`)
            : commitResponse(matched ? `Claude-Session: ${SESSION_URL}` : "Unrelated");
        }),
    );
    const error = yield* observe(find).pipe(Effect.flip);
    expect(error.detail).toContain("pagination");
    expect(reads).toBe(11);
    matched = true;
    // Unchanged completed heads are not rescanned; an unchanged blocked head is never absence.
    expect((yield* observe(find).pipe(Effect.flip)).detail).toContain("pagination");
    expect(reads).toBe(11);
    expect((yield* observe(find, "fresh-account"))?.prUrl).toContain("/pull/8");
  }),
);

it.effect("rejects unreadable commits, stalled cursors, moving heads and invalid result URLs", () =>
  Effect.gen(function* () {
    for (const raw of [
      "broken",
      "{}",
      commitResponse("Unrelated", "same"),
      commitResponse(SESSION_URL, null, "b".repeat(40)),
    ]) {
      const find = yield* makeLookup(
        () => Effect.succeed(restResponse({ body: JSON.stringify([pr()]) })),
        () => Effect.succeed(raw),
      );
      expect((yield* observe(find).pipe(Effect.flip))._tag).toBe("PullRequestProviderError");
    }
    const find = yield* makeLookup(() =>
      Effect.succeed(
        restResponse({
          body: JSON.stringify([{ ...pr(7, SESSION_URL), html_url: "https://evil.test/pull/7" }]),
        }),
      ),
    );
    expect((yield* observe(find).pipe(Effect.flip)).detail).toContain("mismatched");
  }),
);

it.effect("serializes concurrent scans so completed heads are not reread", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let commits = 0;
    const find = yield* makeLookup(
      () => Effect.succeed(restResponse({ body: JSON.stringify([pr()]) })),
      () =>
        Effect.gen(function* () {
          commits++;
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return commitResponse();
        }),
    );
    const first = yield* observe(find).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const second = yield* observe(find).pipe(Effect.forkChild);
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(first)).toBeNull();
    expect(yield* Fiber.join(second)).toBeNull();
    expect(commits).toBe(1);
  }),
);

it.effect(
  "advertises cloud lookup with the API service and carries the verified pinned credential",
  () =>
    Effect.gen(function* () {
      const cli = Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
        withVerifiedCredential: (_, use) =>
          use({
            accountId: "101",
            viewer: "octocat",
            credentialFingerprint: "verified-account",
          }).pipe(
            Effect.provideService(
              GitHubRequestPolicy.PinnedGitHubCredential,
              pinned("verified-account"),
            ),
          ),
      });
      const api = transport(
        () =>
          Effect.gen(function* () {
            const credential = yield* GitHubRequestPolicy.PinnedGitHubCredential;
            expect(credential?.credentialFingerprint).toBe("verified-account");
            return restResponse({ body: JSON.stringify([pr(7, SESSION_URL)]) });
          }),
        () => Effect.die("Body result needs no commit read"),
      );
      const provider = yield* GitHubPullRequestProvider.make.pipe(
        Effect.provide(Layer.merge(cli, api)),
      );
      const read = provider.findCloudSessionPullRequest;
      const verify = provider.withVerifiedCredential;
      if (read === undefined || verify === undefined)
        return yield* Effect.die("Cloud operation unavailable");
      expect((yield* verify(input, () => read(input)))?.prUrl).toBe(
        "https://github.com/fixture/repository/pull/7",
      );
      const cliOnly = yield* GitHubPullRequestProvider.make.pipe(Effect.provide(cli));
      expect(cliOnly.findCloudSessionPullRequest).toBeUndefined();
    }),
);

it.effect("rotates a moving head so the next candidate can be observed on the next pass", () =>
  Effect.gen(function* () {
    const numbers: unknown[] = [];
    const find = yield* makeLookup(
      () => Effect.succeed(restResponse({ body: JSON.stringify([pr(7), pr(8)]) })),
      (request) =>
        Effect.sync(() => {
          const number = request.variables.number;
          numbers.push(number);
          return number === 7
            ? commitResponse("Unrelated", null, "b".repeat(40))
            : commitResponse(`Claude-Session: ${SESSION_URL}`);
        }),
    );
    yield* observe(find).pipe(Effect.flip);
    expect((yield* observe(find))?.prUrl).toBe("https://github.com/fixture/repository/pull/8");
    expect(numbers).toEqual([7, 8]);
  }),
);

it.effect("bounds idle state and expires old partitions without treating capacity as absence", () =>
  Effect.gen(function* () {
    const find = yield* makeLookup(() => Effect.succeed(restResponse()));
    for (let index = 0; index < 128; index++)
      expect(yield* observe(find, `account-${index}`)).toBeNull();
    expect((yield* observe(find, "overflow").pipe(Effect.flip)).detail).toContain("capacity");
    yield* TestClock.adjust("126 minutes");
    expect(yield* observe(find, "overflow")).toBeNull();
  }),
);
