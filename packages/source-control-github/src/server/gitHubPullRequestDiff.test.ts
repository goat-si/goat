import { afterEach, assert, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
import {
  callAt,
  defaultCredential,
  diffRefused,
  layer,
  mockedCredential,
  mockedExecute,
  mockedStackMemberships,
  output,
  pathAt,
  pullRequestFiles,
} from "./GitHubPullRequestApi.testkit.ts";

afterEach(() => {
  mockedExecute.mockReset();
  mockedStackMemberships.mockReset();
  mockedCredential.mockReset();
  mockedCredential.mockImplementation(defaultCredential);
});

layer("GitHub pull request diffs", (it) => {
  it.effect("reads one files page when GitHub refuses the diff, and says it is the last", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.fail(diffRefused));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(2, 1))));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const diff = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.acme.dev",
        number: 7,
      });

      assert.isFalse(diff.truncated);
      assert.isNull(diff.nextCursor);
      expect(diff.patch).toContain("diff --git a/src/file1.ts b/src/file1.ts");
      expect(diff.patch).toContain("diff --git a/src/file2.ts b/src/file2.ts");
      assert.strictEqual(callAt(1).host, "github.acme.dev");
      assert.strictEqual(pathAt(1), "repos/acme/web/pulls/7/files?per_page=100&page=1");
    }),
  );

  it.effect("hands back a cursor for the next page rather than walking on by itself", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.fail(diffRefused));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(100, 0))));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const diff = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.isFalse(diff.truncated);
      assert.isNotNull(diff.nextCursor);
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
    }),
  );

  it.effect("refuses a cursor it never handed out rather than reading it into a request", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getPullRequestDiff({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          cursor: "1&per_page=1",
        }),
      );

      assert.strictEqual(error._tag, "GitHubDiffCursorError");
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("pages an oversized patch by file rather than handing back a severed one", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output("diff --git a/a b/a\n@@ -1 +1 @@", true)),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(1, 1))));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const slice = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.strictEqual(pathAt(1), "repos/acme/web/pulls/7/files?per_page=100&page=1");
      expect(slice.patch).toContain("src/file1.ts");
      expect(slice.patch).not.toContain("diff --git a/a b/a");
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
    }),
  );
});
