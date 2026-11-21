import { rows } from "./gitHubPullRequestTestFixtures.ts";
import { afterEach, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
import {
  layer,
  mockedExecute,
  mockedCredential,
  mockedStackMemberships,
  defaultCredential,
  output,
  encodeJson,
} from "./GitHubPullRequestApi.testkit.ts";

afterEach(() => {
  mockedExecute.mockReset();
  mockedStackMemberships.mockReset();
  mockedCredential.mockReset();
  mockedCredential.mockImplementation(defaultCredential);
});

layer("GitHubPullRequestApi.cursor", (it) => {
  it.effect("keeps equal PR numbers distinct across repositories", () =>
    Effect.gen(function* () {
      const a = rows(1, 3, () => ({ repository: { nameWithOwner: "acme/a" } }))[0];
      const b = rows(1, 3, () => ({ repository: { nameWithOwner: "acme/b" } }))[0];
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            encodeJson({
              data: {
                search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [a, b] },
              },
            }),
          ),
        ),
      );
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const page = yield* cli.searchPullRequests({
        cwd: "/w",
        host: "github.com",
        repositories: ["acme/a", "acme/b"],
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        cursor: {
          updatedBefore: "2026-07-02T00:00:00Z",
          delivered: 1,
          seenAt: [{ repository: "acme/a", number: 3 }],
        },
      });
      expect(page.items.map((item) => [item.repository, item.number])).toEqual([["acme/b", 3]]);
    }),
  );
  it.effect("skips the rows already delivered at a tied boundary before applying the limit", () =>
    Effect.gen(function* () {
      // Twenty pull requests share the boundary instant, then five are older. GitHub's search
      // has no qualifier for a row number, so the boundary always comes back from its start.
      const repository = { nameWithOwner: "acme/web" };
      const tied = rows(20, 1, () => ({ repository }));
      const older = rows(5, 21, () => ({ updatedAt: "2026-07-01T00:00:00Z", repository }));
      mockedExecute.mockImplementation((call) => {
        const variables = call.kind === "graphql" ? (call.variables ?? {}) : {};
        const q = String(variables["q"] ?? "");
        const bound = /updated:<=(\S+)/.exec(q)?.[1];
        const matching = [...tied, ...older].filter(
          (row) => bound === undefined || String(row["updatedAt"]) <= bound,
        );
        const start = variables["after"] == null ? 0 : Number(variables["after"]);
        const end = start + Number(variables["first"]);
        const hasNextPage = end < matching.length;
        return Effect.succeed(
          output(
            encodeJson({
              data: {
                search: {
                  pageInfo: { hasNextPage, endCursor: hasNextPage ? String(end) : null },
                  nodes: matching.slice(start, end),
                },
              },
            }),
          ),
        );
      });
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const batch = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        cursor: {
          updatedBefore: "2026-07-02T00:00:00Z",
          delivered: 10,
          seenAt: Array.from({ length: 10 }, (_, index) => index + 1),
        },
      });

      expect(batch.items.map((item) => item.number)).toEqual([
        11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      ]);

      const across = yield* cli.searchPullRequests({
        cwd: "/w",
        host: "github.com",
        repositories: ["acme/web"],
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        cursor: {
          updatedBefore: "2026-07-02T00:00:00Z",
          delivered: 10,
          seenAt: Array.from({ length: 10 }, (_, index) => ({
            repository: "acme/web",
            number: index + 1,
          })),
        },
      });
      expect(across.items.map((item) => item.number)).toEqual([
        11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      ]);

      // Rows seen earlier that no longer match must not count as skipped, or the rest is lost.
      const moved = { updatedBefore: "2026-07-01T00:00:00Z", delivered: 10 };
      const listedPastMoved = yield* cli.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 3,
        cursor: { ...moved, seenAt: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
      });
      const searchedPastMoved = yield* cli.searchPullRequests({
        cwd: "/w",
        host: "github.com",
        repositories: ["acme/web"],
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 3,
        cursor: {
          ...moved,
          seenAt: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((number) => ({
            repository: "acme/web",
            number,
          })),
        },
      });
      for (const page of [listedPastMoved, searchedPastMoved]) {
        expect(page.items.map((item) => item.number)).toEqual([21, 22, 23]);
        expect(page.truncated).toBe(true);
      }
    }),
  );
});
