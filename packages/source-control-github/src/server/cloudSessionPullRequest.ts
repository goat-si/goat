import { SourceControlProviderKind } from "@goat/contracts";
import {
  PullRequestProviderError,
  type PullRequestProviderApi,
} from "@goat/source-control-core/server/PullRequestProvider";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { GraphQLClient, GraphQLClientError } from "effect/graphql";
import { CloudSessionPullRequestGraphQLGroup } from "./cloudSessionPullRequest.graphql.ts";
import * as GitHubGraphQlClient from "./gitHubGraphQlClient.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubRest from "./GitHubRest.ts";

const OPERATION = "findCloudSessionPullRequest";
const MAX_REQUESTS = 100;
const MAX_PULL_PAGES = 20;
const MAX_CANDIDATES = 2_000;
const MAX_COMMIT_PAGES = 10;
const MAX_SCANS = 128;
const SCAN_IDLE_MS = 125 * 60_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const Pulls = Schema.Array(
  Schema.Struct({
    number: Schema.Int,
    html_url: Schema.String,
    body: Schema.NullOr(Schema.String),
    base: Schema.Struct({ repo: Schema.Struct({ full_name: Schema.String }) }),
    head: Schema.Struct({ ref: Schema.String, sha: Schema.String }),
  }),
);
const decodePulls = Schema.decodeEffect(Schema.fromJsonString(Pulls));

/** Match a whole canonical token, including a full-message trailer, rather than a URL prefix. */
export function containsSessionUrl(text: string, expected: string): boolean {
  const tokens = text.match(/https:\/\/[^\s<>[\]()"'`]+/g) ?? [];
  return tokens.some((token) => token.replace(/[.,;]+$/, "") === expected);
}

export function summarySection(body: string | null): string {
  return (
    /^##\s+Summary[^\S\r\n]*\r?\n([\s\S]*?)(?=^#{1,2}\s|$(?![\s\S]))/im
      .exec(body ?? "")?.[1]
      ?.trim() || "Result PR found. The PR has no Summary section."
  ).slice(0, 4_000);
}

type Candidate = {
  number: number;
  html_url: string;
  head: { ref: string; sha: string };
  summary: string;
  cursor: string | null;
  pages: number;
};
type Scan = {
  lock: ReturnType<typeof Semaphore.makeUnsafe>;
  users: number;
  touchedAt: number;
  pending: Candidate[];
  completed: Map<number, string>;
  blocked: Map<number, string>;
};

export const make = Effect.gen(function* () {
  const api = yield* GitHubRest.GitHubRest;
  const graphql = yield* GraphQLClient.make(
    CloudSessionPullRequestGraphQLGroup.middleware(GitHubGraphQlClient.GitHubGraphQlAuth),
  ).pipe(Effect.provide(GitHubGraphQlClient.layer));
  const scans = new Map<string, Scan>();
  const find = Effect.fn(OPERATION)(function* (
    input: Parameters<NonNullable<PullRequestProviderApi["findCloudSessionPullRequest"]>>[0],
  ) {
    const fail = (detail: string, cause?: unknown) =>
      new PullRequestProviderError({
        provider: SourceControlProviderKind.make("github"),
        operation: OPERATION,
        reason: "failed",
        detail,
        ...(cause === undefined ? {} : { cause }),
      });
    if (
      input.repository.length > 256 ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) ||
      !/^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]{1,256}$/.test(input.sessionUrl)
    ) {
      return yield* fail("Invalid repository or canonical cloud session URL.");
    }
    const pinned = yield* GitHubRequestPolicy.PinnedGitHubCredential;
    if (pinned === null || pinned.host !== input.host) {
      return yield* fail("PR observation needs this project's verified, pinned credential.");
    }
    const key = [
      input.cwd,
      input.host,
      input.repository.toLowerCase(),
      input.sessionUrl,
      pinned.credentialFingerprint,
    ]
      .map(encodeURIComponent)
      .join(":");
    const now = yield* Clock.currentTimeMillis;
    for (const [savedKey, state] of scans) {
      if (state.users === 0 && now - state.touchedAt > SCAN_IDLE_MS) scans.delete(savedKey);
    }
    let state = scans.get(key);
    if (state === undefined) {
      if (scans.size >= MAX_SCANS) {
        return yield* fail("Cloud PR observation capacity is full; absence is unconfirmed.");
      }
      state = {
        lock: Semaphore.makeUnsafe(1),
        users: 0,
        touchedAt: now,
        pending: [],
        completed: new Map(),
        blocked: new Map(),
      };
      scans.set(key, state);
    }
    const scan = state;
    scan.users += 1;
    return yield* Effect.gen(function* () {
      scan.touchedAt = yield* Clock.currentTimeMillis;
      const repo = input.repository.split("/").map(encodeURIComponent).join("/");
      const [owner, name] = input.repository.split("/");
      let requests = 0;
      const checkBudget = () =>
        ++requests > MAX_REQUESTS
          ? Effect.fail(
              fail("The bounded PR observation pass is incomplete; its cursor is retained."),
            )
          : Effect.void;
      const read = Effect.fnUntraced(function* (path: string) {
        yield* checkBudget();
        const response = yield* api.rest({
          host: input.host,
          operation: OPERATION,
          path,
          maxResponseBytes: MAX_RESPONSE_BYTES,
        });
        if (response.truncated || response.invalidUtf8 || response.status !== 200) {
          return yield* fail("GitHub returned an incomplete PR observation page.", response);
        }
        const value = yield* decodePulls(response.body).pipe(
          Effect.mapError((cause) =>
            fail("GitHub returned an unreadable PR observation page.", cause),
          ),
        );
        if (value.length > 100) return yield* fail("GitHub exceeded the PR page bound.");
        return { value, next: /<[^>]+>;\s*rel="next"/.test(response.headers.link ?? "") };
      });
      const result = (pr: Candidate) => {
        const expected = `https://${input.host}/${input.repository}/pull/${pr.number}`;
        return pr.html_url.toLowerCase() !== expected.toLowerCase() ||
          pr.number <= 0 ||
          pr.head.ref.length === 0 ||
          pr.head.ref.length > 512
          ? Effect.fail(fail("GitHub returned a mismatched PR URL or invalid result branch."))
          : Effect.succeed({ prUrl: pr.html_url, branch: pr.head.ref, summary: pr.summary });
      };
      const discovered = new Map<number, Candidate>();
      let listingIncomplete = false;
      // Every admitted PR body precedes commit fallback, including drafts and settled PRs.
      for (let page = 1; page <= MAX_PULL_PAGES; page += 1) {
        const pulls = yield* read(
          `repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`,
        );
        for (const pr of pulls.value) {
          if (pr.base.repo.full_name.toLowerCase() !== input.repository.toLowerCase()) continue;
          const candidate: Candidate = {
            number: pr.number,
            html_url: pr.html_url,
            head: { ...pr.head },
            summary: summarySection(pr.body),
            cursor: null,
            pages: 0,
          };
          if (containsSessionUrl(pr.body ?? "", input.sessionUrl)) return yield* result(candidate);
          discovered.set(pr.number, candidate);
        }
        if (!pulls.next) break;
        if (page === MAX_PULL_PAGES) listingIncomplete = true;
      }
      for (const records of [scan.completed, scan.blocked]) {
        for (const [number, sha] of records) {
          const current = discovered.get(number);
          if (current === undefined || current.head.sha !== sha) records.delete(number);
        }
      }
      scan.pending = scan.pending.flatMap((pr) => {
        const current = discovered.get(pr.number);
        if (current === undefined) return listingIncomplete ? [pr] : [];
        return [
          current.head.sha === pr.head.sha
            ? { ...current, cursor: pr.cursor, pages: pr.pages }
            : current,
        ];
      });
      const queued = new Set(scan.pending.map((pr) => pr.number));
      const additions = [...discovered.values()].filter(
        (pr) =>
          !queued.has(pr.number) &&
          scan.completed.get(pr.number) !== pr.head.sha &&
          scan.blocked.get(pr.number) !== pr.head.sha,
      );
      const overflow = scan.pending.length + additions.length > MAX_CANDIDATES;
      scan.pending.push(...additions.slice(0, Math.max(0, MAX_CANDIDATES - scan.pending.length)));
      while (scan.pending.length > 0) {
        const pr = scan.pending[0]!;
        yield* checkBudget();
        const response = yield* graphql
          .CloudSessionCommits({ owner: owner!, name: name!, number: pr.number, after: pr.cursor })
          .pipe(
            GitHubGraphQlClient.call({
              host: input.host,
              operation: OPERATION,
              maxResponseBytes: MAX_RESPONSE_BYTES,
            }),
            Effect.catchIf(GraphQLClientError.isGraphQLClientError, (cause) =>
              Effect.fail(fail("GitHub returned an unreadable full-commit page.", cause)),
            ),
          );
        const connection = response.repository?.pullRequest;
        if (connection == null || connection.headRefOid !== pr.head.sha) {
          scan.pending.shift();
          scan.pending.push({ ...pr, cursor: null, pages: 0 });
          return yield* fail(
            "The PR head changed or is unavailable; its cursor needs revalidation.",
          );
        }
        const nodes = connection.commits.nodes ?? [];
        if (nodes.length > 100) {
          return yield* fail("GitHub exceeded the full-commit page bound.");
        }
        if (
          nodes.some(
            (entry) => entry !== null && containsSessionUrl(entry.commit.message, input.sessionUrl),
          )
        ) {
          return yield* result(pr);
        }
        pr.pages += 1;
        const pageInfo = connection.commits.pageInfo;
        if (!pageInfo.hasNextPage) {
          scan.completed.set(pr.number, pr.head.sha);
          scan.pending.shift();
        } else if (
          pr.pages >= MAX_COMMIT_PAGES ||
          !pageInfo.endCursor ||
          pageInfo.endCursor.length > 4_096 ||
          pageInfo.endCursor === pr.cursor
        ) {
          scan.blocked.set(pr.number, pr.head.sha);
          scan.pending.shift();
        } else {
          pr.cursor = pageInfo.endCursor;
        }
      }
      if (overflow || listingIncomplete || scan.blocked.size > 0) {
        return yield* fail(
          "PR/commit pagination exceeded the admitted window; absence is unconfirmed.",
        );
      }
      return null;
    }).pipe(
      scan.lock.withPermits(1),
      Effect.ensuring(
        Effect.sync(() => {
          scan.users -= 1;
        }),
      ),
    );
  });
  return (input: Parameters<typeof find>[0]) =>
    find(input).pipe(
      Effect.mapError((cause) => {
        if (cause._tag === "PullRequestProviderError") return cause;
        const limited =
          cause._tag === "GitHubApiRateLimitError" ||
          cause._tag === "SourceControlRateLimitPausedError";
        return new PullRequestProviderError({
          provider: SourceControlProviderKind.make("github"),
          operation: OPERATION,
          reason: limited
            ? "rate-limited"
            : cause._tag === "GitHubApiAuthenticationError" ||
                cause._tag === "GitHubNotSignedInError" ||
                cause._tag === "GitHubHostDisabledError"
              ? "unauthenticated"
              : cause._tag === "GitHubCliMissingError"
                ? "missing-tool"
                : "failed",
          ...(limited && cause.retryAt !== undefined ? { retryAt: cause.retryAt } : {}),
          detail:
            "GitHub PR observation could not be completed. Check project source-control access.",
          cause,
        });
      }),
    );
});
